# Security

## Reporting a vulnerability

Email **security@hellojade.ai**. Do not open a public issue for a security
problem. Include the file and line, a reproduction, and the impact. You will get
an acknowledgment within two business days.

## The two things to know before using this in a browser

1. **An API key in a browser is public.** Anything shipped to a page — an
   attribute, a module constant, a fetched config — is readable by every
   visitor. A leaked key lets anyone post leads under your label. Use the
   `relay-url` mode with a server-side relay (see the Node kit) so the key
   stays on your server.
2. **Rotate, never look up.** hellojade stores only a hash of each key. If a
   key has been exposed, ask for a rotation; the old key is revoked after you
   cut over.

## What this code does not do

- It never logs the API key or puts it in a URL.
- It sends `credentials: "omit"` on every request so cookies never travel to
  the API origin.
- It never retries a `4xx` other than `429`, so a bad payload cannot loop.
