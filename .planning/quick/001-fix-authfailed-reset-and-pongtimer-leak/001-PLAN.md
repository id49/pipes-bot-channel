# Quick Task 001: Fix authFailed reset and pongTimer leak

**Mode:** quick
**Created:** 2026-02-18

## Description

Fix two tech debt items from v1 milestone audit:

1. **BUG**: `service.ts` `stop()` does not reset `authFailed` to `false` in status store - dashboard shows `running: false` permanently after auth failure is corrected and service restarts
2. **MINOR**: `connection.ts` `pongTimer` overwritten without clearing previous reference in `startHeartbeat` interval callback (theoretical timer leak)

## Tasks

### Task 1: Reset authFailed on stop()
- **File:** `src/service.ts` line 84
- **Change:** Add `authFailed: false` to the `updateConnectionStatus` call in `stop()`
- **Before:** `updateConnectionStatus({ connected: false, lastError: null })`
- **After:** `updateConnectionStatus({ connected: false, authFailed: false, lastError: null })`

### Task 2: Clear pongTimer before overwrite
- **File:** `src/connection.ts` line 174
- **Change:** Add guard to clear existing `pongTimer` before assigning a new one in the `startHeartbeat` interval callback
- **Before:** `this.pongTimer = setTimeout(...)`
- **After:** `if (this.pongTimer !== null) { clearTimeout(this.pongTimer); }` then `this.pongTimer = setTimeout(...)`
