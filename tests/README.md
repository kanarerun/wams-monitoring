# WAMS Automated Test Suite

This directory contains automated browser and end-to-end integration tests for the WAMS application using the `browser-automation` runner.

## Test Scripts

| File | Purpose |
|---|---|
| `test-all-features.mjs` | Complete integration test for professor & student workflows |
| `test-live-proctoring.mjs` | Live camera snapshot, audio capture, and screen capture transmission |
| `test-media-upload-load.mjs` | Isolated 20-student media upload, retry, duplicate, limit, and dashboard workload |
| `test-aligned-tables.mjs` | Layout and table column alignment checks across all portals |
| `test-css-audit.mjs` | Full cross-page CSS audit checking for horizontal overflow and alignment |
| `test-student-management.mjs` | Admin student management and student ID generation verification |

## Running Tests

To run any test with the browser automation runner:

```bash
node ~/.codegpt/skills/browser-automation/browser.mjs http://localhost:3000/ --script ./tests/<test-name>.mjs
```

### Media upload load test

`test-media-upload-load.mjs` is a standalone Node test. For a local run, use
the same fresh `file:` database for the server and test, set
`MEDIA_TEST_DB_PATH` to that file, and use a loopback test URL such as
`http://127.0.0.1:3197`.

An isolated Turso staging database can be used only by setting
`MEDIA_TEST_ALLOW_STAGING=1`; the test rejects remote database URLs unless the
hostname is a `staging-*.aws-*.turso.io` endpoint, and API requests must still
target loopback. Never point it at Render or production. The test removes its
own seeded exam, users, captures, and notifications. It does not report
database file growth for remote Turso runs.

The test submits 100 screen captures, 200 camera captures, 40 audio captures,
duplicate requests, invalid and cross-session uploads, and concurrent tab
switches, while querying professor monitoring endpoints. Upload contents are
small test fixtures; file-growth measurements are not representative of
production screenshot sizes.
