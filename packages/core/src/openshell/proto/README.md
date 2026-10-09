# OpenShell API definitions

`openshell.proto`, `datamodel.proto`, `options.proto` and `sandbox.proto` are copied unchanged from
[NVIDIA/OpenShell](https://github.com/NVIDIA/OpenShell/tree/main/proto) at commit
`e1f3c82caa3ed3b65de22889ae7ef32a774878ef` (gateway 0.1.2). They are licensed under the Apache License
2.0, as their headers say; Huddle loads them at runtime to talk to an OpenShell gateway over gRPC.

When OpenShell's API changes, copy the same four files from the matching release.
