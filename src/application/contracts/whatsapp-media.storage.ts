export interface PersistWhatsAppMediaInput {
  readonly storageKey: string;
  readonly content: Buffer;
}

/**
 * Armazenamento binário controlado pela aplicação. A chave é opaca para as
 * camadas HTTP e nunca deve ser exposta ao navegador.
 */
export abstract class WhatsAppMediaStorage {
  abstract write(input: PersistWhatsAppMediaInput): Promise<void>;
  abstract read(storageKey: string): Promise<Buffer>;
  abstract delete(storageKey: string): Promise<void>;
}
