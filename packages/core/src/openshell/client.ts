import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";

/**
 * A small client for an NVIDIA OpenShell gateway (https://github.com/NVIDIA/OpenShell): run a command
 * inside a sandbox, and read and decide the network rules OpenShell drafts when it blocks something.
 * It speaks the gateway's gRPC API from the protobuf files in ./proto, with the same mTLS client
 * certificate the openshell CLI uses.
 */

export interface OpenShellOptions {
  /** The gateway, e.g. https://127.0.0.1:8080 (mTLS) or http://127.0.0.1:8080 (no TLS, this machine only). */
  readonly gateway: string;
  /** Where ca.crt, tls.crt and tls.key are, for an https gateway. */
  readonly certDir?: string;
  readonly workspace?: string;
}

/** A network rule OpenShell drafted after blocking a connection, waiting for a person. */
export interface SandboxRequest {
  readonly sandbox: string;
  readonly id: string;
  readonly rule: string;
  /** host:port pairs the rule would allow. */
  readonly endpoints: readonly string[];
  /** The program inside the sandbox that tried to connect. */
  readonly binary: string;
  readonly rationale: string;
  /** OpenShell's own risk notes; empty when it found nothing to flag. */
  readonly securityNotes: string;
  /** The policy prover's verdict. */
  readonly validation: string;
  readonly hits: number;
  readonly firstSeen: string | null;
  /** Ties an approval to exactly what was reviewed. */
  readonly reviewToken: string;
}

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

/** The CLI's certificates for its default gateway name, which `generate-certs` and the installer write. */
export const DEFAULT_CERT_DIR = join(homedir(), ".config", "openshell", "gateways", "openshell", "mtls");

type Unary = (request: object, metadata: grpc.Metadata, options: grpc.CallOptions, callback: (error: grpc.ServiceError | null, response: never) => void) => void;
type Client = grpc.Client & Record<string, Unary> & { execSandbox(request: object, options: grpc.CallOptions): AsyncIterable<ExecEvent> & grpc.ClientReadableStream<ExecEvent> };
interface ExecEvent {
  readonly stdout?: { readonly data: Uint8Array };
  readonly stderr?: { readonly data: Uint8Array };
  readonly exit?: { readonly exitCode: number };
}
interface Chunk {
  readonly id: string;
  readonly status: string;
  readonly ruleName: string;
  readonly proposedRule?: { readonly endpoints?: readonly { readonly host: string; readonly port: number; readonly ports?: readonly number[] }[] };
  readonly rationale: string;
  readonly securityNotes: string;
  readonly validationResult: string;
  readonly binary: string;
  readonly hitCount: number;
  readonly firstSeenTime?: { readonly seconds: string } | null;
  readonly reviewToken: string;
}

let service: grpc.ServiceClientConstructor | undefined;
function serviceClient(): grpc.ServiceClientConstructor {
  if (service) return service;
  const definition = loader.loadSync("openshell.proto", {
    includeDirs: [fileURLToPath(new URL("./proto/", import.meta.url))],
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as { openshell: { v1: { OpenShell: grpc.ServiceClientConstructor } } };
  service = loaded.openshell.v1.OpenShell;
  return service;
}

/** The gateway's message for an error, without gRPC's status prefix. */
function plain(error: unknown): string {
  const details = (error as grpc.ServiceError | undefined)?.details;
  return details || (error instanceof Error ? error.message : String(error));
}

export class OpenShell {
  readonly gateway: string;
  private readonly workspaceScope: { readonly workspace: string };
  private readonly client: Client;

  constructor(options: OpenShellOptions) {
    const url = new URL(options.gateway);
    this.gateway = options.gateway.replace(/\/$/, "");
    this.workspaceScope = { workspace: options.workspace ?? "default" };
    let credentials: grpc.ChannelCredentials;
    if (url.protocol === "http:") {
      credentials = grpc.credentials.createInsecure();
    } else {
      const dir = options.certDir ?? DEFAULT_CERT_DIR;
      const read = (name: string) => {
        const path = join(dir, name);
        if (!existsSync(path)) throw new Error(`OpenShell's client certificate isn't at ${path}. Set OPENSHELL_TLS_DIR to the folder with ca.crt, tls.crt and tls.key.`);
        return readFileSync(path);
      };
      credentials = grpc.credentials.createSsl(read("ca.crt"), read("tls.key"), read("tls.crt"));
    }
    const target = `${url.hostname}:${url.port || (url.protocol === "http:" ? "80" : "443")}`;
    // An IP address can't be a TLS server name; name the gateway "localhost" (as its certificate does) instead.
    const ip = /^[\d.]+$|^\[?[\da-f:]+\]?$/i.test(url.hostname);
    this.client = new (serviceClient())(target, credentials, ip && url.protocol === "https:" ? { "grpc.ssl_target_name_override": "localhost", "grpc.default_authority": "localhost" } : {}) as unknown as Client;
  }

  /** From HUDDLE_OPENSHELL_GATEWAY (and OPENSHELL_TLS_DIR), or null when OpenShell isn't set up. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): OpenShell | null {
    const gateway = env.HUDDLE_OPENSHELL_GATEWAY?.trim();
    if (!gateway) return null;
    return new OpenShell({ gateway, certDir: env.OPENSHELL_TLS_DIR?.trim() || undefined, workspace: env.OPENSHELL_WORKSPACE?.trim() || undefined });
  }

  private call<T>(method: string, request: object, timeoutMs = 15_000): Promise<T> {
    return new Promise((resolve, reject) => {
      this.client[method]!(request, new grpc.Metadata(), { deadline: Date.now() + timeoutMs }, (error, response) => {
        if (error) reject(new Error(`OpenShell: ${plain(error)}`));
        else resolve(response as T);
      });
    });
  }

  async health(): Promise<{ status: string; version: string }> {
    return this.call("health", {});
  }

  async sandboxes(): Promise<{ name: string; phase: string }[]> {
    const response = await this.call<{ sandboxes: { metadata?: { name?: string }; status?: { phase?: string } | null }[] }>("listSandboxes", { workspaceScope: this.workspaceScope, pageSize: 1000 });
    return response.sandboxes.map((sandbox) => ({
      name: sandbox.metadata?.name ?? "",
      phase: String(sandbox.status?.phase ?? "").replace(/^SANDBOX_PHASE_/, "").toLowerCase(),
    }));
  }

  /** Runs a command in a sandbox and waits for it to finish, with `stdin` as its input. */
  async exec(sandbox: string, command: readonly string[], options: { stdin?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
    const timeoutMs = options.timeoutMs ?? 600_000;
    const stream = this.client.execSandbox(
      {
        workspaceScope: this.workspaceScope,
        sandbox,
        command,
        stdin: Buffer.from(options.stdin ?? ""),
        executionTimeout: { seconds: String(Math.ceil(timeoutMs / 1000)), nanos: 0 },
      },
      { deadline: Date.now() + timeoutMs + 10_000 },
    );
    const abort = () => stream.cancel();
    options.signal?.addEventListener("abort", abort, { once: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let exitCode: number | null = null;
    try {
      for await (const event of stream) {
        if (event.stdout) out.push(Buffer.from(event.stdout.data));
        else if (event.stderr) err.push(Buffer.from(event.stderr.data));
        else if (event.exit) exitCode = event.exit.exitCode;
      }
    } catch (error) {
      throw new Error(`OpenShell: ${plain(error)}`);
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
    return { stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), exitCode };
  }

  /** The rules OpenShell drafted for a sandbox that are waiting on a person. */
  async requests(sandbox: string): Promise<SandboxRequest[]> {
    const response = await this.call<{ chunks: Chunk[] }>("getDraftPolicy", { workspaceScope: this.workspaceScope, sandbox, statusFilter: "pending" });
    return response.chunks
      .filter((chunk) => chunk.status === "pending")
      .map((chunk) => ({
        sandbox,
        id: chunk.id,
        rule: chunk.ruleName,
        endpoints: (chunk.proposedRule?.endpoints ?? []).map((endpoint) => `${endpoint.host}:${endpoint.ports?.length ? endpoint.ports.join(",") : endpoint.port}`),
        binary: chunk.binary,
        rationale: chunk.rationale,
        securityNotes: chunk.securityNotes,
        validation: chunk.validationResult.replace(/^prover:\s*/i, ""),
        hits: chunk.hitCount,
        firstSeen: chunk.firstSeenTime?.seconds ? new Date(Number(chunk.firstSeenTime.seconds) * 1000).toISOString() : null,
        reviewToken: chunk.reviewToken,
      }));
  }

  async approve(sandbox: string, id: string, reviewToken: string): Promise<void> {
    await this.call("approveDraftChunk", { workspaceScope: this.workspaceScope, sandbox, chunkId: id, reviewToken });
  }

  async reject(sandbox: string, id: string, reason: string): Promise<void> {
    await this.call("rejectDraftChunk", { workspaceScope: this.workspaceScope, sandbox, chunkId: id, reason });
  }

  close(): void {
    this.client.close();
  }
}
