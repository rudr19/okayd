### okproof · #101 Team notes

Not proven: 3 of 5 criteria met.

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| 101.1 A user can add a note and see it in the list | met | passed in 1.1s (test) |
| 101.2 Notes over 140 characters show an error and are not saved | met | passed in 0.2s (test) |
| 101.3 A user can delete a note | met | passed in 0.3s (test) |
| 101.4 Notes are still there after a page reload | FAILED | failed in 0.3s (test), refuted by verifier: Note is lost after a page reload (repro: examples/demo/out/.okproof/repro/101.4.json) |
| 101.5 A user can export notes as a text file | untested | — |
