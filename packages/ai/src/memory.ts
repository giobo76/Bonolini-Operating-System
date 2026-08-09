export interface SharedMemoryEntry {
  value: unknown;
  updatedAt: string;
}

export interface SharedMemory {
  get(namespace: string, key: string): Promise<SharedMemoryEntry | undefined>;
  set(namespace: string, key: string, value: unknown): Promise<void>;
  delete(namespace: string, key: string): Promise<boolean>;
  list(namespace: string): Promise<Record<string, SharedMemoryEntry>>;
}

export class InMemorySharedMemory implements SharedMemory {
  private readonly store = new Map<string, Map<string, SharedMemoryEntry>>();

  async get(namespace: string, key: string): Promise<SharedMemoryEntry | undefined> {
    return this.store.get(namespace)?.get(key);
  }

  async set(namespace: string, key: string, value: unknown): Promise<void> {
    const bucket = this.store.get(namespace) ?? new Map<string, SharedMemoryEntry>();
    bucket.set(key, { value, updatedAt: new Date().toISOString() });
    this.store.set(namespace, bucket);
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    const bucket = this.store.get(namespace);
    if (!bucket) {
      return false;
    }
    const deleted = bucket.delete(key);
    if (bucket.size === 0) {
      this.store.delete(namespace);
    }
    return deleted;
  }

  async list(namespace: string): Promise<Record<string, SharedMemoryEntry>> {
    const bucket = this.store.get(namespace);
    if (!bucket) {
      return {};
    }

    return Object.fromEntries(bucket.entries());
  }
}
