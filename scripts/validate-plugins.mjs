import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const plugin = resolve(root, 'plugins/mailroom');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function structuralChecks() {
  const workspacePackage = readJson(resolve(root, 'package.json'));
  const pluginPackage = readJson(resolve(plugin, 'package.json'));
  const codex = readJson(resolve(plugin, '.codex-plugin/plugin.json'));
  const claude = readJson(resolve(plugin, '.claude-plugin/plugin.json'));
  const mcp = readJson(resolve(plugin, '.mcp.json'));
  const codexMarketplace = readJson(resolve(root, '.agents/plugins/marketplace.json'));
  const claudeMarketplace = readJson(resolve(root, '.claude-plugin/marketplace.json'));
  const claudeMarketplacePlugin = claudeMarketplace.plugins?.find(
    (item) => item.name === 'mailroom',
  );
  if (codex.name !== 'mailroom' || claude.name !== 'mailroom') {
    throw new Error('Plugin manifest names must both be mailroom.');
  }
  if (codex.mcpServers !== './.mcp.json' || !mcp.mcpServers?.['mailroom']) {
    throw new Error('Codex manifest must reference the bundled .mcp.json server.');
  }
  if (!existsSync(resolve(plugin, 'skills/mailroom/SKILL.md'))) {
    throw new Error('Mailroom skill is missing.');
  }
  if (!codexMarketplace.plugins?.some((item) => item.name === 'mailroom')) {
    throw new Error('Codex marketplace entry is missing.');
  }
  if (!claudeMarketplacePlugin) {
    throw new Error('Claude marketplace entry is missing.');
  }
  const versions = [
    workspacePackage.version,
    pluginPackage.version,
    claude.version,
    claudeMarketplacePlugin.version,
  ];
  if (versions.some((version) => version !== pluginPackage.version)) {
    throw new Error(`Mailroom versions must all match ${pluginPackage.version}.`);
  }
  if (codex.version !== pluginPackage.version
    && !codex.version.startsWith(`${pluginPackage.version}+codex.`)) {
    throw new Error(`Codex version must use the ${pluginPackage.version} Mailroom release.`);
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
