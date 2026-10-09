import { type Connector, dataIn } from "../connector.ts";

/**
 * A stand-in assistant for building and testing flows: it answers from the `replies` in the flow
 * file. The first key found in the request (ignoring case) wins, then "*"; with neither, it echoes.
 * An answer that is JSON also comes back as data, like a real assistant's structured output.
 */
export const mock: Connector = {
  async send({ assistant, ask }) {
    const replies = assistant.replies ?? {};
    const lower = ask.toLowerCase();
    const key = Object.keys(replies).find((candidate) => candidate !== "*" && lower.includes(candidate.toLowerCase()));
    const text = key ? replies[key]! : (replies["*"] ?? `(${assistant.name ?? assistant.id} would answer: ${ask})`);
    const data = dataIn(text);
    return data === undefined ? { text } : { text, data };
  },
};
