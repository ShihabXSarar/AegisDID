/**
 * AegisDID — Client-side Secure Identity Storage (IndexedDB)
 * 
 * IMPORTANT: Strictly local storage. idSecret, salt, and raw vectors
 * are stored solely in the user's browser IndexedDB and NEVER transmitted.
 */

export interface StoredIdentity {
  idSecret: string; // Hex representation of 254-bit scalar
  salt: string;     // Hex representation of 254-bit scalar
  uReg: number[];   // 128 quantized values in [1, 255]
  cEmb: string;     // Hex of C_emb
  cId: string;      // Hex of C_id (Identity Commitment)
  didKey: string;   // did:key:z6Mk...
  createdAt: string;// ISO timestamp
  /**
   * MODEL_HASH bound into C_id at enrollment. A claim can only ever satisfy a policy whose
   * on-chain modelHash equals this value — the circuit recomputes C_id from the *public*
   * modelHash, so a different one yields a leaf that is not in the cohort tree.
   * Optional because identities enrolled before this field existed have no record of it.
   */
  modelHash?: string;
  /** Ed25519 public key behind `didKey`, hex. Safe to publish. */
  didPublicKey?: string;
  /**
   * Ed25519 secret key behind `didKey`, hex. NEVER transmitted — same enclave-only rule as
   * idSecret and salt. Optional because identities enrolled before real keypairs existed
   * have no secret key for their DID.
   */
  didPrivateKey?: string;
}

const DB_NAME = 'aegis_did_secure_storage';
const DB_VERSION = 1;
const STORE_NAME = 'beneficiary_credentials';
const IDENTITY_KEY = 'primary_identity';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB is not available in this environment.'));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveBeneficiaryIdentity(identity: StoredIdentity): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(identity, IDENTITY_KEY);

    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getBeneficiaryIdentity(): Promise<StoredIdentity | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(IDENTITY_KEY);

      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function clearBeneficiaryIdentity(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(IDENTITY_KEY);

    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
