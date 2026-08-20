# WAMS Automated Test Suite

This directory contains automated browser and end-to-end integration tests for the WAMS application using the `browser-automation` runner.

## Test Scripts

| File | Purpose |
|---|---|
| `test-all-features.mjs` | Complete integration test for professor & student workflows |
| `test-ai-proctor.mjs` | Verification of AI-assisted multi-face and multi-voice heuristics |
| `test-live-proctoring.mjs` | Live camera snapshot, audio capture, and screen capture transmission |
| `test-aligned-tables.mjs` | Layout and table column alignment checks across all portals |
| `test-box-layout.mjs` | Verification of capture container scrolling boxes & max-heights |
| `test-css-audit.mjs` | Full cross-page CSS audit checking for horizontal overflow and alignment |
| `test-student-management.mjs` | Admin student management and student ID generation verification |

## Running Tests

To run any test with the browser automation runner:

```bash
node ~/.codegpt/skills/browser-automation/browser.mjs http://localhost:3000/ --script ./tests/<test-name>.mjs
```
