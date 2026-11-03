/** The site's one-use dispatch binding travels in the existing release request id (K.9), not a new protocol field. */
export function websiteDispatch({ dispatchRequestId, dispatchCommit, env = process.env }) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') return null;
  if (typeof dispatchRequestId !== 'string' || !/^[0-9a-f]{32}$/.test(dispatchRequestId)) {
    throw new Error('a website dispatch requires a site-issued dispatch-request-id (lowercase hex32)');
  }
  if (typeof dispatchCommit !== 'string' || !/^[0-9a-f]{40}$/.test(dispatchCommit)) {
    throw new Error('a website dispatch requires a pinned dispatch-commit (lowercase hex40)');
  }
  if (dispatchCommit !== env.GITHUB_SHA) throw new Error('the dispatch commit differs from the actual GitHub run commit; request a new dispatch in WordPress');
  if (env.GITHUB_RUN_ATTEMPT !== '1') throw new Error('a website dispatch must be its first run attempt; request a new dispatch in WordPress');
  return { requestId: `site-${dispatchRequestId}`, commit: dispatchCommit };
}
