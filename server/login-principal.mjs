export function canonicalLoginPrincipal(login, configuredNetwork) {
  const reportedChain = login?.chainName?.trim().toLowerCase();
  if (
    !['vrsctest', 'vrsc'].includes(configuredNetwork) ||
    reportedChain !== configuredNetwork ||
    typeof login.iAddress !== 'string' ||
    login.iAddress.length === 0
  ) {
    throw new Error('Verified login does not match the configured chain');
  }
  return {
    iAddress: login.iAddress,
    friendlyName: login.friendlyName ?? null,
    chain: configuredNetwork,
  };
}
