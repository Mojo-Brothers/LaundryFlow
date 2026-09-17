// ============================================================================
// Storage Abstraction Layer (Supabase Storage -> Cloudflare R2 Evolution)
// ============================================================================

export interface UploadInput {
  file: File | Blob;
  path: string;
  contentType: string;
}

export interface StoredFile {
  storagePath: string;
  publicUrl: string;
  sizeBytes: number;
}

export interface FileStorageService {
  upload(input: UploadInput): Promise<StoredFile>;
  getUrl(storagePath: string): Promise<string>;
  delete(storagePath: string): Promise<void>;
}

/**
 * Supabase Storage Implementation
 */
export class SupabaseStorageService implements FileStorageService {
  private bucket: string;

  constructor(bucket = 'laundry-attachments') {
    this.bucket = bucket;
  }

  async upload(input: UploadInput): Promise<StoredFile> {
    // In production with real Supabase client:
    // const { data, error } = await supabase.storage.from(this.bucket).upload(input.path, input.file, { contentType: input.contentType });
    const mockUrl = `https://storage.laundryflow.id/${this.bucket}/${input.path}`;
    return {
      storagePath: input.path,
      publicUrl: mockUrl,
      sizeBytes: input.file.size || 0,
    };
  }

  async getUrl(storagePath: string): Promise<string> {
    return `https://storage.laundryflow.id/${this.bucket}/${storagePath}`;
  }

  async delete(_storagePath: string): Promise<void> {
    // await supabase.storage.from(this.bucket).remove([storagePath]);
  }
}

/**
 * Future Cloudflare R2 Implementation (Zero-Rewrite swap)
 */
export class CloudflareR2StorageService implements FileStorageService {
  private endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  async upload(input: UploadInput): Promise<StoredFile> {
    const url = `${this.endpoint}/${input.path}`;
    return {
      storagePath: input.path,
      publicUrl: url,
      sizeBytes: input.file.size,
    };
  }

  async getUrl(storagePath: string): Promise<string> {
    return `${this.endpoint}/${storagePath}`;
  }

  async delete(_storagePath: string): Promise<void> {
    // S3 client delete command
  }
}
