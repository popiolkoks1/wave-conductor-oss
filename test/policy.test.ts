import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBash, checkWrite, checkTool } from '../src/policy.js';

const denied = [
  'git push origin main',
  'git push --force',
  'git reset --hard HEAD~1',
  'git reset --soft HEAD && git reset --hard',
  'git clean -fd',
  'git add -A',
  'git add --all',
  'git add .',
  'cd x && git add . && git commit -m y',
  'git checkout -- .',
  'git restore .',
  'git branch -D feat/x',
  'git branch --delete feat/x',
  'git worktree remove ../wh-x',
  'git rebase main',
  'git commit --amend --no-edit',
  'git checkout main',
  'git switch master',
  'git merge main',
  'git merge --no-ff origin/main',
  'git stash drop',
  'gh repo delete foo/bar --yes',
  'gh pr merge 12',
  'sudo rm x',
  'rm -rf /',
  'rm -rf ~',
  'rm -rf ..',
  'rm -fr $HOME',
];
const allowed = [
  'git add src/a.ts src/b.ts',
  'git commit -m "feat: x"',
  'git merge --no-ff wave/add',
  'git checkout -b feat/main-menu',
  'git checkout feat/main-menu',
  'git status --porcelain',
  'git diff main...HEAD',
  'git log --oneline main..HEAD',
  'rm -rf node_modules',
  'rm -rf ./build',
  'npm test',
  'git reset --mixed HEAD~1',
  'git merge-base --is-ancestor art/x main',
  'git merge-tree --write-tree main art/scene-v2',
];

for (const c of denied) test(`denied: ${c}`, () => assert.ok(checkBash(c), c));
for (const c of allowed) test(`allowed: ${c}`, () => assert.equal(checkBash(c), null, c));

test('manifest restrictions', () => {
  assert.ok(checkBash('node scripts/deploy-production.mjs', ['deploy-production']));
  assert.equal(checkBash('node scripts/build.mjs', ['deploy-production']), null);
});

test('writes stay within allowed roots', () => {
  assert.equal(checkWrite('/r/wt/a/b.ts', ['/r/wt']), null);
  assert.ok(checkWrite('/r/wt-other/b.ts', ['/r/wt']));
  assert.ok(checkWrite('/r/wt/../main/b.ts', ['/r/wt']));
  assert.equal(checkTool('Edit', { file_path: '/mem/x.md' }, ['/r/wt', '/mem'], []), null);
  assert.ok(checkTool('Write', { file_path: '/etc/hosts' }, ['/r/wt'], []));
  assert.equal(checkTool('Read', { file_path: '/etc/hosts' }, ['/r/wt'], []), null);
});

import { checkDenyPath } from '../src/policy.js';

test('git stash is shared across worktrees; only list/show are allowed', () => {
  assert.ok(checkBash('git stash'));
  assert.ok(checkBash('git stash push -m x'));
  assert.ok(checkBash('git stash pop'));
  assert.equal(checkBash('git stash list'), null);
  assert.equal(checkBash('git stash show -p'), null);
});

test('frozen paths are relative to the worktree, including paths with spaces', () => {
  const wt = '/projects/sample project/ui';
  const deny = ['math/', 'docs/BOOK_EVENTS.md', 'frontend/packages/', 'src/types/'];
  assert.ok(checkDenyPath(`${wt}/math/games/x.py`, wt, deny));
  assert.ok(checkDenyPath(`${wt}/docs/BOOK_EVENTS.md`, wt, deny));
  assert.ok(checkDenyPath(`${wt}/frontend/packages/utils/a.ts`, wt, deny));
  assert.ok(checkDenyPath(`${wt}/frontend/apps/sample-app/src/types/book.ts`, wt, deny));
  assert.equal(checkDenyPath(`${wt}/frontend/apps/sample-app/src/game/stateLayout.ts`, wt, deny), null);
  assert.equal(checkDenyPath(`${wt}/docs/resubmit/F3-A.md`, wt, deny), null);
  assert.equal(checkDenyPath('/elsewhere/math/x', wt, deny), null);
  assert.ok(checkTool('Edit', { file_path: `${wt}/math/a.py` }, [wt], [], deny, wt));
});

test('Git global options cannot bypass command restrictions', () => {
  for (const c of [
    'git -C "/projects/sample project/audio" push -u origin feat/sound-v4',
    "git -C '/x y' reset --hard HEAD",
    'git -c core.pager=cat -C /r branch -D x',
    'git --git-dir=/r/.git --work-tree=/r add -A',
    'git --no-pager -C /r stash',
    'W=/r; git -C "$W" push 2>&1 | tail -8',
  ]) assert.ok(checkBash(c), c);
  for (const c of ['git -C "/projects/sample project/audio" status', 'git -C /r log --oneline main..HEAD', 'git -C /r add src/a.ts'])
    assert.equal(checkBash(c), null, c);
});
