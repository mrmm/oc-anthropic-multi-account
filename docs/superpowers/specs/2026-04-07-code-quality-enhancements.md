# Code Quality Enhancements Specification

**Date:** 2026-04-07
**Status:** Proposed
**Author:** Code Review Analysis

---

## Executive Summary

Full code review of `oc-anthropic-multi-account` identified ~700 lines of duplication between `index.mjs` (runtime plugin) and TypeScript CLI modules, 73 `any` type usages, a 343-line god function, 77% untested code, and several correctness bugs (divergent `MODEL_PRICING`, missing `team` plan price, missing `execSync` import).

---

## Enhancement List (Prioritized)

### P0 — Architectural (eliminate root cause of duplication)

| #      | Enhancement                                                                                                                                                                                                                                  | Impact                               | Effort |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------ |
| **E1** | **Convert `index.mjs` to TypeScript** and compile both plugin + CLI from the same source. Extract shared code into `src/shared/` modules imported by both sides. Eliminates ~700 lines of duplication and the divergent `MODEL_PRICING` bug. | Eliminates all DRY violations        | High   |
| **E2** | **Define core interfaces**: `Account`, `AppData`, `UsageState`, `ConsumptionData`, `Thresholds`, `RateLimitMetric`. Replace all 73 `any` usages.                                                                                             | Type safety, IDE support, fewer bugs | Medium |

### P1 — Structural (KISS improvements)

| #      | Enhancement                                                                                                                                                                                                       | Impact                         | Effort  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------- |
| **E3** | **Break up the 343-line fetch interceptor** into composable functions: `selectAccount()`, `refreshWithFallback()`, `executeRequest()`, `handleRateLimit()`, `handleAuthFailure()`, `trackUsage()`, `logRequest()` | Readability, testability       | Medium  |
| **E4** | **Extract `upsertAccount(data, name, fields)`** to `data.ts`. Replaces 6 copy-pasted blocks in `commands.ts` and `oauth.ts`.                                                                                      | -60 lines of duplication       | Low     |
| **E5** | **Extract `buildAuthorizationUrl()` and `exchangeCodeForTokens()`** to `oauth.ts`. Replaces 4 copies each.                                                                                                        | -120 lines of duplication      | Low     |
| **E6** | **Unify token refresh** into a single `refreshToken()` with options for retry/dedup.                                                                                                                              | Consistent behavior, -80 lines | Medium  |
| **E7** | **Move `createOAuthTokenRequestInit`** from `thresholds.ts` to `oauth.ts`                                                                                                                                         | Correct module boundaries      | Trivial |

### P2 — Quality & Robustness

| #       | Enhancement                                                                                                                                                                                             | Impact                 | Effort  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------- |
| **E8**  | **Consolidate constants**: Move magic strings (`API_VERSION`, `PING_MODEL`, `USAGE_ENDPOINT`, `OAUTH_USER_AGENT`, log paths) to `constants.ts`. Single `PLAN_PRICES` constant (fix missing `team: 30`). | Single source of truth | Low     |
| **E9**  | **Add error logging to silent catch blocks**. At minimum, `console.debug()` for diagnosability.                                                                                                         | Debuggability          | Low     |
| **E10** | **Fix `MODEL_PRICING` divergence**: Use 4-element tuples everywhere (with cache pricing). CLI `costs` command currently underreports.                                                                   | Correctness            | Low     |
| **E11** | **Cache `loadData()` in memory** during a request lifecycle instead of calling `readFileSync` on every API call.                                                                                        | Performance            | Low     |
| **E12** | **Remove dead code**: commented-out `selectWeightedAccount`, unused `_requestBodyMeta`, debug log at `/tmp/sketchybar_logs.txt`                                                                         | Cleanliness            | Trivial |
| **E13** | **Fix `request-log.ts:73`**: Add missing `execSync` import                                                                                                                                              | Correctness            | Trivial |

### P3 — Testing

| #       | Enhancement                                                                                                                  | Impact                              | Effort |
| ------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------ |
| **E14** | **Add tests for `oauth.ts`**: Token refresh, token exchange, error cases                                                     | Cover 504 critical lines            | Medium |
| **E15** | **Add tests for `rate-limits.ts`**: Header parsing, cost calculation, extra credit detection                                 | Cover 148 lines, catch pricing bugs | Low    |
| **E16** | **Add tests for `render-usage.ts`**: Progress bars, account cards, JSON output                                               | Cover 464 lines                     | Medium |
| **E17** | **Fix test portability**: Replace hardcoded paths in `sketchybar.test.ts`, use temp dirs instead of real data file           | CI reliability                      | Low    |
| **E18** | **Add integration tests for the fetch interceptor**: Mock Anthropic API, test account switching, 429 handling, token refresh | Cover core plugin logic             | High   |

---

## Detailed Findings

### DRY Violations

**Root cause:** `index.mjs` cannot import TypeScript modules at runtime. Every function in the TS modules has been copy-pasted into `index.mjs`.

Duplicated functions (~20 total):

- `safeReadJSON`/`safeWriteJSON` — `index.mjs:159-188` ↔ `data.ts:24-52`
- `normalizeAccountFields`/`normalizeMultiAuthShape` — `index.mjs:49-100` ↔ `data.ts:65-132`
- `loadData`/`saveData` — `index.mjs:203-266` ↔ `data.ts:137-195`
- `normalizeThresholds`/`getAccountThresholds` — `index.mjs:455-483` ↔ `thresholds.ts:26-67`
- `MODEL_PRICING`/`getModelPricing`/`calculateCost` — `index.mjs:732-771` ↔ `rate-limits.ts:99-119`
- `detectExtraCredit` — `index.mjs:821-841` ↔ `rate-limits.ts:121-140`
- `ensureAllAccountsInState`/`resolveStaleMetrics` — `index.mjs:843-886` ↔ `render-usage.ts:45-78`
- `logSwitch` — `index.mjs:858-868` ↔ `auto-evaluate.ts:10-22`
- `createOAuthTokenRequestInit` — `index.mjs:268-286` ↔ `thresholds.ts:4-24`
- `generateState` — 4 locations total
- Account upsert pattern — 6 locations in `commands.ts` and `oauth.ts`
- OAuth URL construction — 4 locations
- Token exchange — 5 locations

### KISS Violations

1. **343-line fetch interceptor** (`index.mjs:1335-1678`) — god function
2. **Nested `while(true)` loops** with complex break/continue in fetch handler
3. **132-line `selectThresholdAccount`** with 5 nested helper closures
4. **Inline SSE parser** (69 lines) inside a `.then()` callback
5. **Per-request migration check** (`_migrateLegacyLog` on every request)
6. **Per-request compression scan** (`_compressOldMonths` via setTimeout every request)

### Type Safety

- 73 instances of `: any` across TypeScript files
- No `Account`, `AppData`, `UsageData` interfaces defined
- `node-compat.d.ts` declares all Node.js modules as `any`
- `EMPTY_DATA` uses `as any[]` escape hatches
- Plan field inconsistently typed (sometimes string, sometimes object)

### Error Handling

- 10+ silent `catch {}` blocks
- No input validation on CLI threshold arguments (can set `--threshold-session 500`)
- CLI token refresh has no retry logic (unlike runtime)
- `request-log.ts:73` uses `execSync` without importing it

### Test Coverage

| Coverage       | Files                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| Tested         | `auto-evaluate.ts`, `data.ts` (partial), `thresholds.ts`, `constants.ts`, `sketchybar.ts`                            |
| Untested (77%) | `commands.ts`, `config.ts`, `oauth.ts`, `rate-limits.ts`, `render-usage.ts`, `request-log.ts`, `cli.ts`, `index.mjs` |

### Correctness Bugs

1. `MODEL_PRICING` in `rate-limits.ts` missing cache pricing → CLI underreports costs
2. `render-usage.ts:192-196` missing `team: 30` plan price
3. `request-log.ts:73` — `execSync` not imported
4. `auto-evaluate.ts:32` — debug log to `/tmp/sketchybar_logs.txt` in production

---

## Recommended Execution Order

1. **E1** (convert to TS) → foundational, unlocks everything
2. **E2** (interfaces) → alongside E1
3. **E8, E10, E12, E13** → quick wins
4. **E3** (break up fetch) → now testable after E1
5. **E14-E18** (testing) → modular codebase makes tests easy
6. **E9, E11** → polish
