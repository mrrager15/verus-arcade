/**
 * Netwerkdiagnose voor de LAN-test (alleen lezen). Draait op Windows via de relay:
 *   node scripts/agent/relay-client.mjs run node scripts/agent/net-check.mjs [poort]
 * Toont de LAN-adressen van de pc, of er iets luistert op de poort, het
 * netwerkprofiel (Privé/Openbaar) en de firewallregels voor node.exe.
 */
import os from 'node:os';
import net from 'node:net';
import { execFileSync } from 'node:child_process';

const port = Number(process.argv[2] ?? 8100);

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
  networkProfiles: ps('Get-NetConnectionProfile | Select-Object Name,InterfaceAlias,NetworkCategory | ConvertTo-Json -Compress'),
  firewallRulesForNode: ps("Get-NetFirewallApplicationFilter | Where-Object { $_.Program -like '*node*' } | ForEach-Object { $r = $_ | Get-NetFirewallRule; [pscustomobject]@{ program=$_.Program; name=$r.DisplayName; enabled=[string]$r.Enabled; action=[string]$r.Action; direction=[string]$r.Direction; profile=[string]$r.Profile } } | ConvertTo-Json -Compress"),
  firewallRulesForPort: ps(`Get-NetFirewallPortFilter | Where-Object { $_.LocalPort -eq '${port}' } | ForEach-Object { $r = $_ | Get-NetFirewallRule; [pscustomobject]@{ name=$r.DisplayName; enabled=[string]$r.Enabled; action=[string]$r.Action; direction=[string]$r.Direction; profile=[string]$r.Profile } } | ConvertTo-Json -Compress`),
}, null, 2));
