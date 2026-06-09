# Experimental devices

A log of speculative, viability-test device ideas — devices whose point is to
**prove a seam in the protocol works**, not to be something an average setup is
expected to have.

These are not roadmap commitments and not normative. A satellite author or the
core team might build one to demonstrate that the capability model can carry a
given fact or behaviour end-to-end; a typical layout will not include it. The
test is "does the *protocol interaction* hold up?" — so an experimental device is
allowed to hand-wave its hardware or algorithms (assume a sensor or model we
have not built), as long as everything it puts on the wire is real and uses only
the public capability seams a built-in would.

Each entry specs one device: what it is, which existing capabilities it declares,
the single thing it proves, and the hand-waves it's allowed. If an idea outgrows
"viability test" and becomes a thing the system should genuinely support, it
graduates to an ADR and/or a satellite repo and leaves this log.

| #                                          | Device               | Proves                                                                              | Builds on        |
| ------------------------------------------ | -------------------- | ----------------------------------------------------------------------------------- | ---------------- |
| [001](001-vision-length-station.md)        | Vision length station | A device other than the train can report and change `train_length_mm` at runtime    | ADR-023, ADR-007 |
