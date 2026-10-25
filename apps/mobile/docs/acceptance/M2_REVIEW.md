# M2 independent review and disposition

Read-only review covered all five implementation commits 6581b4b..976c212.
No Critical or Minor findings. Three Important findings were reproduced and
fixed in one pass; no second review was claimed.

| Finding                                                                          | Fix                                                                                                                                                 | RED→GREEN evidence                                                                                                           |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| English “API key is/password is” bypassed credential detection                   | Label detector accepts English is; same policy governs preview, edited confirmation, manual save/update                                             | memory-runtime.test.ts and memory-extraction.test.ts                                                                         |
| Source deletion/change could interleave after runtime check and before insertion | saveCandidate requires transient MemoryChatEvidence; repository checks source existence/status/original content inside the insert/dedup transaction | memory-extraction.test.ts interleaved deletion/change; repository test retains saved/pinned memory after later chat deletion |
| Exact accented/Cyrillic/Greek search missed matches                              | Query folds ASCII only, consistent with SQLite lower, preserving exact non-ASCII characters                                                         | memory-repository.test.ts Éclair/МОСКВА/Σπίτι                                                                                |

Reviewer ran 5 suites/15 tests and two temporary UI probes, plus disk
upgrade/reopen, concurrent pin, draft refresh and repeated-pagination probes.
Final post-fix verification is recorded in PROJECT_STATE.md.

## Decisions and limitations

- Candidate commit signature was tightened to require evidence; cost is one
  internal argument at runtime/repository callers. No protocol or schema change.
- Native M0/M1 builds and native M2 migration/reopen/UI/lifecycle/backup remain
  NOT_RUN_ENVIRONMENT. Cost: those behaviors still need provisioned-device acceptance.
- M1 live-provider acceptance remains NOT_RUN_ENVIRONMENT: no real API credential
  or paid call. Cost: real provider behavior remains unverified.
- Arbitrary unlabelled-secret recognition is outside the conservative detector.
  Cost: users must keep credentials in Secure Storage, not Memory.
- M3 identity/pairing/sync stays excluded. Cost: cross-device usage awaits its phase.

Deferred minors: none.
