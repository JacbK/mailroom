import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const plugin = resolve(root, 'plugins/gmail-switchboard');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function structuralChecks() {
  const codex = readJson(resolve(plugin, '.codex-plugin/plugin.json'));
  const claude = readJson(resolve(plugin, '.claude-plugin/plugin.json'));
  const mcp = readJson(resolve(plugin, '.mcp.json'));
  const codexMarketplace = readJson(resolve(root, '.agents/plugins/marketplace.json'));
  const claudeMarketplace = readJson(resolve(root, '.claude-plugin/marketplace.json'));
  if (codex.name !== 'gmail-switchboard' || claude.name !== 'gmail-switchboard') {
    throw new Error('Plugin manifest names must both be gmail-switchboard.');
  }
  if (codex.mcpServers !== './.mcp.json' || !mcp.mcpServers?.['gmail-switchboard']) {
    throw new Error('Codex manifest must reference the bundled .mcp.json server.');
  }
  if (!existsSync(resolve(plugin, 'skills/gmail-switchboard/SKILL.md'))) {
    throw new Error('Gmail Switchboard skill is missing.');
  }
  if (!codexMarketplace.plugins?.some((item) => item.name === 'gmail-switchboard')) {
    throw new Error('Codex marketplace entry is missing.');
  }
  if (!claudeMarketplace.plugins?.some((item) => item.name === 'gmail-switchboard')) {
    throw new Error('Claude marketplace entry is missing.');
  }
}

function runIfAvailable(command, args) {
  const probe = spawnSync('which', [command], { encoding: 'utf8' });
  if (probe.status !== 0) return false;
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return true;
}

structuralChecks();

const codexValidator = resolve(
  homedir(),
  '.codex/skills/.system/plugin-creator/scripts/validate_plugin.py',
);
if (existsSync(codexValidator)) {
  const result = spawnSync('python3', [codexValidator, plugin], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
} else {
  process.stdout.write('Codex plugin-creator validator not installed; structural validation passed.\n');
}

if (!runIfAvailable('claude', ['plugin', 'validate', '--strict', plugin])) {
  process.stdout.write('Claude CLI not installed; structural Claude validation passed.\n');
}

process.stdout.write('Plugin validation passed.\n');
