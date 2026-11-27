// Patch actions as one function. Each branch is one row of the decision table
// "patch actions" in DEVELOPER.md; test/decide.test.js has one case per row.

/**
 * @param {{applies: boolean, sensitive: boolean, verify: boolean, apply: boolean, confirmVerify: boolean, confirmApply: boolean, verifyResult?: 'pass'|'fail'|'skipped'|null}} c
 * @returns {{row: number, runVerify: boolean, doApply: boolean, reason: string}}
 */
export function decideVerify(c) {
  if (!c.applies) return { row: 1, runVerify: false, reason: 'the patch does not apply' };
  if (!c.verify) return { row: 2, runVerify: false, reason: 'no --verify command given' };
  if (!c.sensitive) return { row: 3, runVerify: true, reason: 'verify in a temporary worktree' };
  if (!c.confirmVerify) {
    return { row: 4, runVerify: false, reason: 'the patch touches files that control builds or dependencies; verification needs confirmation (--yes or an interactive yes)' };
  }
  return { row: 5, runVerify: true, reason: 'confirmed, verify in a temporary worktree' };
}

export function decideApply(c) {
  if (!c.applies) return { row: 1, doApply: false, reason: 'the patch does not apply' };
  if (!c.apply) return { row: 2, doApply: false, reason: 'no --apply given' };
  if (!c.confirmApply) return { row: 6, doApply: false, reason: 'not confirmed, pass --yes or answer yes on a terminal' };
  if (!c.verify) return { row: 7, doApply: true, reason: 'confirmed' };
  if (c.verifyResult === 'pass') return { row: 8, doApply: true, reason: 'confirmed and verified' };
  return { row: 9, doApply: false, reason: 'verification did not pass, the working tree was not changed' };
}
