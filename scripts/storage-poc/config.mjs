export const POC_NETWORK = 'vrsctest';
export const POC_IDENTITY = 'arcade-storage-poc@';
export const POC_REFERRAL = 'Arcade@';
export const POC_LEAF_NAME = 'arcade-storage-poc';

export const ACKNOWLEDGEMENTS = {
  createIdentity: 'CREATE_VRSCTEST_STORAGE_POC_IDENTITY',
  writeSentinel: 'WRITE_VRSCTEST_STORAGE_POC_SENTINEL',
  writeSmallJson: 'WRITE_VRSCTEST_STORAGE_POC_SMALL_JSON',
  writeSmallFile: 'WRITE_VRSCTEST_STORAGE_POC_SMALL_FILE',
  testEncryption: 'TEST_VRSCTEST_STORAGE_POC_ENCRYPTION',
};

export const VDXF_URIS = {
  smallJson: 'Arcade::storage.poc.small-json',
  preservationSentinel: 'Arcade::storage.poc.preservation-sentinel',
  smallFile: 'Arcade::storage.poc.small-file',
};

export function assertVrsctest(info) {
  if (info?.testnet !== true) {
    throw new Error('Refusing operation: RPC daemon did not report testnet=true');
  }
}

export function requireAcknowledgement(expected) {
  if (process.env.STORAGE_POC_ACK !== expected) {
    throw new Error(
      `Refusing write: set STORAGE_POC_ACK=${expected} to acknowledge this VRSCTEST operation`,
    );
  }
}

export function assertSafeIdentity(identityName) {
  if (identityName !== POC_IDENTITY) {
    throw new Error(`Refusing write to non-PoC identity: ${identityName}`);
  }
  if (identityName.toLowerCase() === 'arcade@') {
    throw new Error('Refusing write to Arcade@');
  }
}
