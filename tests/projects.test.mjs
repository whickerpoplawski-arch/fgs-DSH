/**
 * M1 Project 隔离：一题一图、命令、迁移、改图必须有活动 Project。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { apply as applyPlugin } from '../index.js';
import { ProjectRegistry } from '../controller/projects.js';
import { callRoute, ensureActiveProject, makeFakeAgent, makeFakeHost, projectGraphPath, tmpDir, wireServices } from './helpers.mjs';

const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'origin-only.yaml');

function boot(overrides = {}) {
  const host = makeFakeHost();
  const services = wireServices(host);
  host.ctx.services = { ...host.ctx.services, ...services };
  applyPlugin(host.ctx, { stateDir: '.fgs', verifyMode: 'regex', ...overrides });
  const cwd = tmpDir();
  const agent = makeFakeAgent('sess-proj', cwd);
  host.emit('agent/created', { agent });
  const command = host.commands.find((item) => item.name === 'fgs');
  const fgs = (raw) => command.handler({ agent, rawInput: raw });
  return { host, agent, cwd, command, fgs };
}

async function seed(host, agent, brief) {
  const result = await host.callTool('fgs_seed', { brief }, agent);
  assert.equal(result.ok, true, result.text);
  return result;
}

test('ProjectRegistry：建 3 题互不覆盖，slug 化，重复 id 拒', () => {
  const root = path.join(tmpDir(), '.fgs');
  const registry = new ProjectRegistry(root);
  const a = registry.create({ id: 'Alpha', title: '题 A' });
  const b = registry.create({ id: 'beta_2' });
  const c = registry.create({ id: 'My Problem!' });
  assert.equal(a.id, 'alpha');
  assert.equal(b.id, 'beta_2');
  assert.equal(c.id, 'my_problem_');
  assert.equal(registry.list().length, 3);
  assert.equal(registry.getActive(), null, 'create 本身不切换活动题');
  for (const id of ['alpha', 'beta_2', 'my_problem_']) {
    const dir = registry.projectRoot(id);
    assert.equal(fs.existsSync(path.join(dir, 'workspace')), true);
    assert.equal(fs.existsSync(path.join(dir, 'meta.json')), true);
    const meta = registry.readMeta(id);
    assert.equal(meta.id, id);
    assert.equal(meta.state, 'created');
    assert.equal(meta.roundSeq, 0);
    assert.equal(fs.existsSync(path.join(dir, 'graph.yaml')), false, '建题不种图');
  }
  assert.throws(() => registry.create({ id: 'ALPHA' }), /已存在/);
  assert.throws(() => registry.create({ id: '' }), /非法/);
  assert.throws(() => registry.create({ id: '   ' }), /非法/);
  registry.setActive('beta_2');
  assert.equal(registry.getActive(), 'beta_2');
  assert.throws(() => registry.setActive('missing'), /不存在/);

  const sneaky = registry.normalizeId('../etc/passwd');
  assert.match(sneaky, /^[a-z0-9_-]+$/);
  assert.equal(sneaky.includes('/'), false);
  assert.equal(sneaky.includes('..'), false);
  const parked = registry.create({ id: '../etc/passwd' });
  const parkedRoot = registry.projectRoot(parked.id);
  assert.equal(parkedRoot.startsWith(path.resolve(root, 'projects') + path.sep), true);
  const index = JSON.parse(fs.readFileSync(registry.indexPath, 'utf8'));
  assert.equal(index.activeProblemId, 'beta_2');
  assert.equal(index.problems.length, 4);
});

test('/fgs new|switch|list：活动题切换后 status 指向该题', async () => {
  const { host, agent, cwd, fgs } = boot();
  const listedEmpty = fgs('list');
  assert.equal(listedEmpty.kind, 'success');
  assert.match(listedEmpty.text, /无 Project/);

  const created = fgs('new alpha');
  assert.equal(created.kind, 'success', JSON.stringify(created));
  assert.match(created.text, /alpha/);
  assert.equal(fs.existsSync(path.join(cwd, '.fgs', 'projects', 'alpha', 'workspace')), true);
  assert.equal(fs.existsSync(path.join(cwd, '.fgs', 'competition.json')), true);
  const titled = fgs('new titled 端口扫描题');
  assert.equal(titled.kind, 'success', JSON.stringify(titled));
  assert.match(fs.readFileSync(path.join(cwd, '.fgs', 'projects', 'titled', 'meta.json'), 'utf8'), /端口扫描题/);
  fgs('switch alpha');

  await seed(host, agent, 'alpha-brief');
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '扫 alpha', from: ['fact_origin'] }],
  }, agent);

  const beta = fgs('new beta');
  assert.equal(beta.kind, 'success', JSON.stringify(beta));
  await seed(host, agent, 'beta-brief');

  const list = fgs('list');
  assert.match(list.text, /\* beta/);
  assert.match(list.text, /alpha/);
  assert.match(list.text, /role=/);
  assert.match(list.text, /open=/);
  assert.match(list.text, /satisfied=/);
  assert.match(list.text, /Execute/);
  assert.match(list.text, /Decide/);

  const statusBeta = fgs('status');
  assert.match(statusBeta.text, /Project beta/);
  assert.match(statusBeta.text, /open=0/);

  const switched = fgs('switch alpha');
  assert.equal(switched.kind, 'success');
  const statusAlpha = fgs('status');
  assert.match(statusAlpha.text, /Project alpha/);
  assert.match(statusAlpha.text, /open=1/);
  const missing = fgs('switch nope');
  assert.equal(missing.kind, 'error');
  assert.match(missing.text, /不存在/);
});

test('两题隔离：图、草稿、workspace、同一 turn 下的 commit_step 互不串', async () => {
  const { host, agent, cwd, fgs } = boot();
  fgs('new alpha');
  await seed(host, agent, 'brief-a');
  const drafted = await host.callTool('fgs_open_step', { action: '只属于 A', from: ['fact_origin'] }, agent);
  assert.equal(drafted.ok, true, drafted.text);
  const drafted2 = await host.callTool('fgs_open_step', { action: 'A 的第二步', from: ['fact_origin'] }, agent);
  assert.equal(drafted2.ok, true, drafted2.text);

  fgs('new beta');
  await seed(host, agent, 'brief-b');
  const betaStatus = await host.callTool('fgs_status', {}, agent);
  assert.match(betaStatus.text, /Project: beta/);
  assert.doesNotMatch(betaStatus.text, /草稿/);
  const betaCommit = await host.callTool('fgs_commit', {}, agent);
  assert.equal(betaCommit.ok, false);
  assert.match(betaCommit.text, /草稿为空/);

  fgs('switch alpha');
  const alphaCommit = await host.callTool('fgs_commit', {}, agent);
  assert.equal(alphaCommit.ok, true, alphaCommit.text);
  fgs('new gamma');
  await seed(host, agent, 'brief-g');
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '只属于 C', from: ['fact_origin'] }],
  }, agent);

  const alphaYaml = fs.readFileSync(projectGraphPath(cwd, 'alpha'), 'utf8');
  const betaYaml = fs.readFileSync(projectGraphPath(cwd, 'beta'), 'utf8');
  const gammaYaml = fs.readFileSync(projectGraphPath(cwd, 'gamma'), 'utf8');
  assert.match(alphaYaml, /只属于 A/);
  assert.doesNotMatch(alphaYaml, /只属于 C/);
  assert.doesNotMatch(betaYaml, /step_001/);
  assert.match(gammaYaml, /只属于 C/);
  assert.doesNotMatch(gammaYaml, /只属于 A/);
  assert.notEqual(
    path.join(cwd, '.fgs', 'projects', 'alpha', 'workspace'),
    path.join(cwd, '.fgs', 'projects', 'gamma', 'workspace'),
  );

  host.ctx.setTurn(7);
  fgs('switch alpha');
  assert.equal((await host.callTool('fgs_submit_fact', { title: 'a-fact', content: 'a' }, agent)).ok, true);
  assert.equal((await host.callTool('fgs_commit_step', {}, agent)).ok, true);
  const second = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(second.ok, false);
  assert.match(second.text, /一轮只吃一个 open step/);

  fgs('switch gamma');
  assert.equal((await host.callTool('fgs_submit_fact', { title: 'g-fact', content: 'g' }, agent)).ok, true);
  const satisfy = await host.callTool('fgs_satisfy_goal', {
    goalId: 'goal_final', reason: 'r', satisfiedBy: ['fact_001'],
  }, agent);
  assert.equal(satisfy.ok, false);
  assert.match(satisfy.text, /Execute 轮不得调用/);
  const gammaClose = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(gammaClose.ok, true, gammaClose.text);
  assert.doesNotMatch(fs.readFileSync(projectGraphPath(cwd, 'alpha'), 'utf8'), /g-fact/);
  assert.doesNotMatch(fs.readFileSync(projectGraphPath(cwd, 'gamma'), 'utf8'), /a-fact/);

  fgs('switch beta');
  const betaAgain = await host.callTool('fgs_status', {}, agent);
  assert.match(betaAgain.text, /Project: beta/);
  assert.doesNotMatch(betaAgain.text, /草稿/);
  assert.match(betaAgain.text, /Decide/);
});

test('旧 .fgs/graph.yaml 在首次访问时迁到 projects/default 并留 .bak', async () => {
  const cwd = tmpDir();
  const fgsRoot = path.join(cwd, '.fgs');
  fs.mkdirSync(fgsRoot, { recursive: true });
  const original = fs.readFileSync(FIXTURE, 'utf8');
  fs.writeFileSync(path.join(fgsRoot, 'graph.yaml'), original);
  fs.writeFileSync(path.join(fgsRoot, 'graph.json'), '{"facts":[],"goals":[],"steps":[]}\n');

  const host = makeFakeHost();
  wireServices(host);
  host.ctx.services = { ...host.ctx.services, ...{ systemPrompt: host.ctx.systemPrompt, commands: host.ctx.commands, webServer: host.ctx.webServer } };
  applyPlugin(host.ctx, { stateDir: '.fgs' });
  const agent = makeFakeAgent('sess-migrate', cwd);
  const command = host.commands.find((item) => item.name === 'fgs');
  const listed = command.handler({ agent, rawInput: 'list' });
  assert.equal(listed.kind, 'success', JSON.stringify(listed));
  assert.match(listed.text, /\* default/);
  assert.match(listed.text, /fact_origin|Decide|satisfied=no/);

  const migrated = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.equal(migrated, original);
  assert.equal(fs.readFileSync(path.join(fgsRoot, 'graph.yaml.bak'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(fgsRoot, 'graph.yaml')), false);
  assert.equal(fs.existsSync(path.join(fgsRoot, 'graph.json.bak')), true);
  const index = JSON.parse(fs.readFileSync(path.join(fgsRoot, 'competition.json'), 'utf8'));
  assert.equal(index.activeProblemId, 'default');
  assert.equal(fs.existsSync(path.join(cwd, '.fgs', 'projects', 'default', 'workspace')), true);
  assert.equal(fs.existsSync(path.join(cwd, '.fgs', 'projects', 'default', 'meta.json')), true);

  const again = command.handler({ agent, rawInput: 'list' });
  assert.equal(fs.readFileSync(projectGraphPath(cwd), 'utf8'), original, '重复访问不得覆盖已迁移的图');
  assert.match(again.text, /default/);
});

test('没有活动 Project 时改图被拒（fgs_seed / open_step / commit）', async () => {
  const { host, agent, fgs } = boot();
  for (const [name, args] of [
    ['fgs_seed', { brief: 'x' }],
    ['fgs_open_step', { action: 'a', from: ['fact_origin'] }],
    ['fgs_commit', {}],
    ['fgs_submit_fact', { title: 't' }],
  ]) {
    const denied = await host.callTool(name, args, agent);
    assert.equal(denied.ok, false, name);
    assert.match(denied.text, /没有活动 Project/, name);
  }
  const status = await host.callTool('fgs_status', {}, agent);
  assert.equal(status.ok, true);
  assert.match(status.text, /没有活动 Project/);

  const created = fgs('new lone');
  assert.equal(created.kind, 'success');
  const beforeSeed = await host.callTool('fgs_open_step', { action: 'a', from: ['fact_origin'] }, agent);
  assert.equal(beforeSeed.ok, false);
  assert.match(beforeSeed.text, /fgs_seed|种题/);
  await seed(host, agent, 'now-active');
  const opened = await host.callTool('fgs_open_step', { action: 'a', from: ['fact_origin'] }, agent);
  assert.equal(opened.ok, true, opened.text);
});

test('/fgs init 是 new default 的兼容别名', async () => {
  const { cwd, fgs } = boot();
  const missing = fgs('init');
  assert.equal(missing.kind, 'error');
  const init = fgs('init 目标 http://x 拿 FLAG');
  assert.equal(init.kind, 'success', JSON.stringify(init));
  assert.match(init.text, /graph\.yaml/);
  assert.equal(fs.existsSync(projectGraphPath(cwd, 'default')), true);
  assert.match(fs.readFileSync(projectGraphPath(cwd, 'default'), 'utf8'), /fact_origin/);
  const again = fgs('init 再来一次');
  assert.equal(again.kind, 'error');
  assert.match(again.text, /已经种过题/);
});

test('HTTP /fgs/state 支持 ?problemId=，无参回退活动 Project', async () => {
  const { host, agent, cwd, fgs } = boot();
  ensureActiveProject(host, agent, 'alpha');
  await seed(host, agent, 'alpha-brief');
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: 'alpha-step', from: ['fact_origin'] }],
  }, agent);
  fgs('new beta');
  await seed(host, agent, 'beta-brief');

  const active = await callRoute(host.routes[0], '/fgs/state');
  assert.equal(active.json.problemId, 'beta');
  assert.equal(active.json.role, 'decide');
  assert.equal(active.json.root, path.join(cwd, '.fgs', 'projects', 'beta'));

  const alpha = await callRoute(host.routes[0], '/fgs/state?problemId=alpha');
  assert.equal(alpha.json.active, true);
  assert.equal(alpha.json.problemId, 'alpha');
  assert.equal(alpha.json.role, 'execute');
  assert.equal(alpha.json.counts.open, 1);
  assert.equal(alpha.json.steps[0].action, 'alpha-step');

  const bySession = await callRoute(host.routes[0], '/fgs/state?sessionId=sess-proj&problemId=alpha');
  assert.equal(bySession.json.problemId, 'alpha');
  const other = await callRoute(host.routes[0], '/fgs/state?sessionId=someone-else&problemId=alpha');
  assert.equal(other.json.active, false);

  assert.equal(active.json.pluginGeneration, 4);
  assert.match(active.json.buildTag, /\+project/);
  assert.doesNotMatch(active.json.buildTag, /clean-session/);
});
