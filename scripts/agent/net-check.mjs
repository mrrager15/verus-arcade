/**
 * Netwerkdiagnose voor de LAN-test (alleen lezen). Draait op Windows via de relay:
 *   node scripts/agent/relay-client.mjs run node scripts/agent/net-check.mjs [poort]
 * Toont de LAN-adressen van de pc, of er iets luistert op de poort, het
 * netwerkprofiel (Privé/Openbaar) en de firewallregels voor node.exe.
 */
import os from 'node:os';
import net from 'node:net';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const pingIndex = args.indexOf('--ping');
const pingTarget = pingIndex >= 0 ? args[pingIndex + 1] : null;
const port = Number(args.filter((a, i) => a !== '--ping' && i !== pingIndex + 1)[0] ?? 8100);
if (pingTarget && !/^\d{1,3}(\.\d{1,3}){3}$/.test(pingTarget)) throw new Error('--ping vereist een IPv4-adres');

const addresses = [];
for (const [name, list] of Object.entries(os.networkInterfaces())) {
  for (const a of list ?? []) {
    if (a.family === 'IPv4' && !a.internal) addresses.push({ interface: name, address: a.address });
  }
}

function probe(host) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 2000 });
    socket.once('connect', () => { socket.destroy(); resolve('luistert'); });
    socket.once('timeout', () => { socket.destroy(); resolve('time-out'); });
    socket.once('error', (e) => resolve(`fout: ${e.code}`));
  });
}

function ps(command) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', timeout: 20_000 }).trim();
  } catch (e) {
    return `niet beschikbaar (${e.message.split('\n')[0]})`;
  }
}

const listening = { '127.0.0.1': await probe('127.0.0.1') };
for (const a of addresses) listening[a.address] = await probe(a.address);

console.log(JSON.stringify({
  node: process.version,
  execPath: process.execPath,
  port,
  lanAddresses: addresses,
  listening,
  firewallProfiles: ps('Get-NetFirewallProfile | Select-Object Name,Enabled,DefaultInboundAction,AllowInboundRules,AllowLocalFirewallRules | ConvertTo-Json -Compress'),
  securityProducts: ps("@(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName FirewallProduct) + @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct) | Select-Object displayName,productState | ConvertTo-Json -Compress"),
  ping: pingTarget ? (() => { try { return execFileSync('ping.exe', ['-n', '2', '-w', '1500', pingTarget], { encoding: 'utf8', timeout: 10_000 }).trim().split('\n').slice(-3).join(' | '); } catch (e) { return `geen antwoord (${(e.stdout ?? e.message).toString().trim().split('\n').slice(-2).join(' | ')})`; } })() : null,
  networkProfiles: ps('Get-NetConnectionProfile | Select-Object Name,InterfaceAlias,NetworkCategory | ConvertTo-Json -Compress'),
  firewallRulesForNode: ps("Get-NetFirewallApplicationFilter | Where-Object { $_.Program -like '*node*' } | ForEach-Object { $r = $_ | Get-NetFirewallRule; [pscustomobject]@{ program=$_.Program; name=$r.DisplayName; enabled=[string]$r.Enabled; action=[string]$r.Action; direction=[string]$r.Direction; profile=[string]$r.Profile } } | ConvertTo-Json -Compress"),
  firewallRulesNetsh: (() => { try { return execFileSync('netsh.exe', ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in'], { encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }).split(/\r?\n\r?\n/).filter((block) => new RegExp(`LocalPort:\\s+${port}\\b|Verus Arcade`).test(block)).map((b) => b.replace(/\s+/g, ' ').trim()); } catch (e) { return `niet beschikbaar (${e.message.split('\n')[0]})`; } })(),
  firewallBlockRulesInbound: (() => { try { return execFileSync('netsh.exe', ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in', 'verbose'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }).split(/\r?\n\r?\n/).filter((block) => /Enabled:\s+Yes/.test(block) && /Action:\s+Block/.test(block)).map((b) => b.replace(/-{10,}/g, '').replace(/\s+/g, ' ').trim()); } catch (e) { return `niet beschikbaar (${e.message.split('\n')[0]})`; } })(),
  firewallRulesForPort: ps(`Get-NetFirewallPortFilter | Where-Object { $_.LocalPort -eq '${port}' } | ForEach-Object { $r = $_ | Get-NetFirewallRule; [pscustomobject]@{ name=$r.DisplayName; enabled=[string]$r.Enabled; action=[string]$r.Action; direction=[string]$r.Direction; profile=[string]$r.Profile } } | ConvertTo-Json -Compress`),
}, null, 2));
