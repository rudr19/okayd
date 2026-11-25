### okproof · #101 Team notes

Not proven: 3 of 5 criteria met.

| Criterion | Verdict | Level | Evidence |
| --- | --- | --- | --- |
| 101.1 A user can add a note and see it in the list | met | E2/E2 ▰▰ | passed in 0.9s (test) |
| 101.2 Notes over 140 characters show an error and are not saved | met | E2/E2 ▰▰ | passed in 0.1s (test) |
| 101.3 A user can delete a note | met | E2/E2 ▰▰ | passed in 0.2s (test) |
| 101.4 Notes are still there after a page reload | FAILED | E0/E2 ▱▱ | failed in 0.2s (test), refuted by verifier: Note is lost after a page reload (repro: examples/demo/out/.okproof/repro/101.4.json) |
| 101.5 A user can export notes as a text file | untested | E0/E2 ▱▱ | — |

Levels: E0 claimed · E1 a tagged test passed · E2 solid test · E3 survived adversarial verification · E4 proven in CI.
