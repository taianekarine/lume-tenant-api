import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { notFound, validationError } from '../../core/errors/app-error';
import { PrismaService } from '../database/prisma/prisma.service';
import {
  DEFAULT_WHATSAPP_EXPORT_LIMITS,
  normalizeBrazilianPhone,
  parseWhatsAppExportArchive,
  type ParsedWhatsAppExport,
  type WhatsAppExportParserLimits,
} from './whatsapp-export-parser';
import {
  createWhatsAppImportWorkbook,
  WHATSAPP_HISTORY_STATE_OPTIONS,
  type WhatsAppHistoryConversationMapping,
  type WhatsAppHistoryStateOption,
} from './whatsapp-export-workbook';
import { WhatsAppImportService } from './whatsapp-import.service';

const MANIFEST_VERSION = '1.0';
const MANIFEST_FILE = 'manifest.json';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMPORT_DEPARTMENTS = new Set([
  'commercial',
  'purchasing',
  'controlling',
  'personnel-department',
  'financial',
  'management',
  'maintenance',
  'monitoring',
  'operations',
]);

interface StoredArchive {
  archiveId: string;
  archiveName: string;
  archiveSha256: string;
  storageFileName: string;
  chatFileName: string;
  suggestedContactName: string | null;
  suggestedPhoneE164: string | null;
  senders: readonly { name: string; messageCount: number }[];
  messageCount: number;
  attachmentCount: number;
  missingAttachmentCount: number;
  startedAt: string | null;
  endedAt: string | null;
  mapping: WhatsAppHistoryConversationMapping | null;
}

interface StoredManifest {
  schemaVersion: typeof MANIFEST_VERSION;
  id: string;
  companyId: string;
  channelId: string;
  channelName: string;
  channelPhoneE164: string;
  actorUserId: string;
  actorUsername: string;
  status: 'draft' | 'applied';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  appliedAt: string | null;
  archives: StoredArchive[];
}

export interface CreateWhatsAppHistoryImportInput {
  companyId: string;
  actorUserId: string;
  actorUsername: string;
  commandId: string;
  channelId: string;
}

export interface UpdateWhatsAppHistoryMappingInput {
  phoneE164: string;
  contactName: string;
  companySenderName: string;
  state: WhatsAppHistoryStateOption;
  departmentCode: string;
  ownerUsername?: string | null;
}

function finiteConfig(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const value = config.get<number | string>(key);
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw validationError(`${label} deve ser um identificador válido.`);
  }
}

function assertInside(root: string, candidate: string): void {
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw validationError('O caminho do lote de importação é inválido.');
  }
}

function mappingIssues(
  archive: StoredArchive,
  mapping: WhatsAppHistoryConversationMapping | null,
): string[] {
  if (!mapping) return ['Revise e confirme os dados desta conversa.'];
  const issues: string[] = [];
  if (!normalizeBrazilianPhone(mapping.phoneE164)) {
    issues.push('Informe um número de WhatsApp válido com DDD.');
  }
  if (!mapping.contactName.trim()) issues.push('Informe o nome do contato.');
  if (
    !archive.senders.some((sender) => sender.name === mapping.companySenderName)
  ) {
    issues.push('Selecione qual remetente representa a empresa.');
  }
  if (!WHATSAPP_HISTORY_STATE_OPTIONS.includes(mapping.state)) {
    issues.push('Selecione o estado atual do atendimento.');
  }
  if (!IMPORT_DEPARTMENTS.has(mapping.departmentCode)) {
    issues.push('Selecione um departamento válido.');
  }
  if (mapping.state === 'human-active' && !mapping.ownerUsername?.trim()) {
    issues.push('Atendimento humano ativo exige um atendente responsável.');
  }
  return issues;
}

function presentManifest(manifest: StoredManifest) {
  const archives = manifest.archives.map((archive) => {
    const issues = mappingIssues(archive, archive.mapping);
    return {
      archiveId: archive.archiveId,
      archiveName: archive.archiveName,
      contactName: archive.mapping?.contactName ?? archive.suggestedContactName,
      phoneE164: archive.mapping?.phoneE164 ?? archive.suggestedPhoneE164,
      companySenderName: archive.mapping?.companySenderName ?? null,
      state: archive.mapping?.state ?? null,
      departmentCode: archive.mapping?.departmentCode ?? 'commercial',
      ownerUsername: archive.mapping?.ownerUsername ?? null,
      senders: archive.senders,
      messageCount: archive.messageCount,
      attachmentCount: archive.attachmentCount,
      missingAttachmentCount: archive.missingAttachmentCount,
      startedAt: archive.startedAt,
      endedAt: archive.endedAt,
      status: issues.length === 0 ? 'ready' : 'needs-review',
      issues,
    };
  });
  return {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    channel: {
      id: manifest.channelId,
      name: manifest.channelName,
      phoneE164: manifest.channelPhoneE164,
    },
    status: manifest.status,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    expiresAt: manifest.expiresAt,
    appliedAt: manifest.appliedAt,
    totals: {
      archives: archives.length,
      ready: archives.filter((archive) => archive.status === 'ready').length,
      needsReview: archives.filter(
        (archive) => archive.status === 'needs-review',
      ).length,
      messages: archives.reduce(
        (sum, archive) => sum + archive.messageCount,
        0,
      ),
      attachments: archives.reduce(
        (sum, archive) => sum + archive.attachmentCount,
        0,
      ),
      missingAttachments: archives.reduce(
        (sum, archive) => sum + archive.missingAttachmentCount,
        0,
      ),
    },
    archives,
  };
}

@Injectable()
export class WhatsAppHistoryImportService {
  private readonly root: string;
  private readonly limits: WhatsAppExportParserLimits;
  private readonly maximumArchives: number;
  private readonly retentionMs: number;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.root = resolve(
      config.get<string>('WHATSAPP_IMPORT_ROOT') ??
        resolve(process.cwd(), 'var', 'imports', 'whatsapp'),
    );
    this.maximumArchives = finiteConfig(
      config,
      'WHATSAPP_HISTORY_IMPORT_MAX_ARCHIVES',
      5_000,
    );
    this.retentionMs =
      finiteConfig(config, 'WHATSAPP_HISTORY_IMPORT_RETENTION_HOURS', 48) *
      60 *
      60 *
      1_000;
    this.limits = {
      maximumArchiveBytes: finiteConfig(
        config,
        'WHATSAPP_HISTORY_IMPORT_MAX_ARCHIVE_BYTES',
        DEFAULT_WHATSAPP_EXPORT_LIMITS.maximumArchiveBytes,
      ),
      maximumEntries: finiteConfig(
        config,
        'WHATSAPP_HISTORY_IMPORT_MAX_ENTRIES',
        DEFAULT_WHATSAPP_EXPORT_LIMITS.maximumEntries,
      ),
      maximumUncompressedBytes: finiteConfig(
        config,
        'WHATSAPP_HISTORY_IMPORT_MAX_UNCOMPRESSED_BYTES',
        DEFAULT_WHATSAPP_EXPORT_LIMITS.maximumUncompressedBytes,
      ),
      maximumTextBytes: finiteConfig(
        config,
        'WHATSAPP_HISTORY_IMPORT_MAX_TEXT_BYTES',
        DEFAULT_WHATSAPP_EXPORT_LIMITS.maximumTextBytes,
      ),
    };
  }

  async channels(companyId: string) {
    return this.prisma.whatsAppChannel.findMany({
      where: { companyId, enabled: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, phoneNumber: true },
    });
  }

  async create(input: CreateWhatsAppHistoryImportInput) {
    assertUuid(input.commandId, 'commandId');
    assertUuid(input.channelId, 'channelId');
    return this.withBatchLock(
      `${input.companyId}:${input.commandId}`,
      async () => {
        const channel = await this.prisma.whatsAppChannel.findFirst({
          where: {
            id: input.channelId,
            companyId: input.companyId,
            enabled: true,
          },
          select: { id: true, name: true, phoneNumber: true },
        });
        if (!channel) throw notFound('Canal de WhatsApp');
        const batchPath = this.batchPath(input.companyId, input.commandId);
        await mkdir(batchPath, { recursive: true });
        const existing = await this.tryReadManifest(
          input.companyId,
          input.commandId,
        );
        if (existing) {
          if (
            existing.actorUserId !== input.actorUserId ||
            existing.channelId !== input.channelId
          ) {
            throw validationError(
              'Este identificador de importação já foi utilizado com outros dados.',
            );
          }
          return presentManifest(existing);
        }
        const now = new Date();
        const manifest: StoredManifest = {
          schemaVersion: MANIFEST_VERSION,
          id: input.commandId,
          companyId: input.companyId,
          channelId: channel.id,
          channelName: channel.name,
          channelPhoneE164: channel.phoneNumber,
          actorUserId: input.actorUserId,
          actorUsername: input.actorUsername,
          status: 'draft',
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + this.retentionMs).toISOString(),
          appliedAt: null,
          archives: [],
        };
        await this.writeManifest(manifest);
        return presentManifest(manifest);
      },
    );
  }

  async detail(companyId: string, batchId: string) {
    return presentManifest(await this.readManifest(companyId, batchId));
  }

  async addArchive(
    companyId: string,
    batchId: string,
    file: {
      originalName: string;
      sizeBytes: number;
      content: Buffer;
    },
  ) {
    return this.withBatchLock(`${companyId}:${batchId}`, async () => {
      const manifest = await this.readManifest(companyId, batchId);
      if (manifest.status !== 'draft') {
        throw validationError(
          'Uma importação concluída não aceita novos backups.',
        );
      }
      if (file.content.byteLength !== file.sizeBytes) {
        throw validationError('O backup recebido está incompleto.');
      }
      const parsed = await parseWhatsAppExportArchive(
        file.originalName,
        file.content,
        this.limits,
      );
      const duplicate = manifest.archives.find(
        (archive) => archive.archiveSha256 === parsed.archiveSha256,
      );
      if (duplicate) return presentManifest(manifest);
      if (manifest.archives.length >= this.maximumArchives) {
        throw validationError(
          `Cada lote aceita no máximo ${this.maximumArchives} backups.`,
        );
      }
      const storageFileName = `${parsed.archiveId}.zip`;
      const archivePath = resolve(
        this.batchPath(companyId, batchId),
        storageFileName,
      );
      assertInside(this.batchPath(companyId, batchId), archivePath);
      await writeFile(archivePath, file.content, {
        flag: 'wx',
        mode: 0o600,
      }).catch(async (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const current = await readFile(archivePath);
        if (!current.equals(file.content)) {
          throw validationError(
            'O backup conflita com um arquivo já recebido.',
          );
        }
      });
      manifest.archives.push(this.storedArchive(parsed, storageFileName));
      manifest.updatedAt = new Date().toISOString();
      await this.writeManifest(manifest);
      return presentManifest(manifest);
    });
  }

  async updateMapping(
    companyId: string,
    batchId: string,
    archiveId: string,
    input: UpdateWhatsAppHistoryMappingInput,
  ) {
    return this.withBatchLock(`${companyId}:${batchId}`, async () => {
      const manifest = await this.readManifest(companyId, batchId);
      if (manifest.status !== 'draft') {
        throw validationError(
          'Uma importação concluída não pode ser alterada.',
        );
      }
      const archive = manifest.archives.find(
        (item) => item.archiveId === archiveId,
      );
      if (!archive) throw notFound('Conversa importada');
      const phoneE164 = normalizeBrazilianPhone(input.phoneE164);
      const mapping: WhatsAppHistoryConversationMapping = {
        archiveId,
        phoneE164: phoneE164 ?? input.phoneE164.trim(),
        contactName: input.contactName.trim().slice(0, 160),
        companySenderName: input.companySenderName.trim(),
        state: input.state,
        departmentCode: input.departmentCode,
        ownerUsername: input.ownerUsername?.trim() || null,
      };
      const issues = mappingIssues(archive, mapping);
      if (issues.length > 0) {
        throw validationError(issues.join(' '));
      }
      archive.mapping = mapping;
      manifest.updatedAt = new Date().toISOString();
      await this.writeManifest(manifest);
      return presentManifest(manifest);
    });
  }

  async workbook(companyId: string, batchId: string) {
    const manifest = await this.readManifest(companyId, batchId);
    const generated = await this.generateWorkbook(manifest);
    return {
      ...generated,
      fileName: `historico-whatsapp-${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx`,
    };
  }

  async apply(companyId: string, batchId: string, cutoffAt: Date) {
    return this.withBatchLock(`${companyId}:${batchId}`, async () => {
      const manifest = await this.readManifest(companyId, batchId);
      if (!Number.isFinite(cutoffAt.getTime())) {
        throw validationError('Informe uma data de corte válida.');
      }
      const generated = await this.generateWorkbook(manifest);
      const packagePath = resolve(
        this.batchPath(companyId, batchId),
        'package',
      );
      assertInside(this.batchPath(companyId, batchId), packagePath);
      await mkdir(packagePath, { recursive: true });
      const workbookPath = resolve(
        packagePath,
        'modelo-importacao-atendimentos-whatsapp.xlsx',
      );
      await writeFile(workbookPath, generated.content, { mode: 0o600 });
      const importer = new WhatsAppImportService(this.prisma, this.root);
      const batchName = `historico-whatsapp-${batchId}`;
      const importInput = {
        companyId,
        channelId: manifest.channelId,
        actorUsername: manifest.actorUsername,
        batchName,
        batchId,
        packagePath,
        cutoffAt,
        confirmation: `APPLY:${batchId}`,
      };
      const validation = await importer.validate(importInput);
      if (!validation.valid) {
        throw validationError(
          'A revisão final encontrou dados inválidos. Corrija as conversas antes de importar.',
        );
      }
      const result = await importer.apply(importInput);
      manifest.status = 'applied';
      manifest.appliedAt = new Date().toISOString();
      manifest.updatedAt = manifest.appliedAt;
      await this.writeManifest(manifest);
      return result;
    });
  }

  private async generateWorkbook(manifest: StoredManifest) {
    const incomplete = manifest.archives.filter(
      (archive) => mappingIssues(archive, archive.mapping).length > 0,
    );
    if (manifest.archives.length === 0) {
      throw validationError(
        'Adicione pelo menos um backup antes de continuar.',
      );
    }
    if (incomplete.length > 0) {
      const description =
        incomplete.length === 1
          ? 'Uma conversa ainda precisa de revisão.'
          : `${incomplete.length} conversas ainda precisam de revisão.`;
      throw validationError(description);
    }
    const exports: ParsedWhatsAppExport[] = [];
    for (const archive of manifest.archives) {
      const archivePath = resolve(
        this.batchPath(manifest.companyId, manifest.id),
        archive.storageFileName,
      );
      assertInside(
        this.batchPath(manifest.companyId, manifest.id),
        archivePath,
      );
      const archiveStat = await stat(archivePath);
      const content = await readFile(archivePath);
      if (archiveStat.size !== content.byteLength) {
        throw validationError(
          `O backup ${archive.archiveName} está incompleto.`,
        );
      }
      const parsed = await parseWhatsAppExportArchive(
        archive.archiveName,
        content,
        this.limits,
      );
      if (parsed.archiveSha256 !== archive.archiveSha256) {
        throw validationError(`O backup ${archive.archiveName} foi alterado.`);
      }
      exports.push(parsed);
    }
    return createWhatsAppImportWorkbook(
      exports,
      manifest.archives.map(
        (archive) => archive.mapping as WhatsAppHistoryConversationMapping,
      ),
      manifest.channelPhoneE164,
    );
  }

  private storedArchive(
    parsed: ParsedWhatsAppExport,
    storageFileName: string,
  ): StoredArchive {
    return {
      archiveId: parsed.archiveId,
      archiveName: parsed.archiveName,
      archiveSha256: parsed.archiveSha256,
      storageFileName,
      chatFileName: parsed.chatFileName,
      suggestedContactName: parsed.suggestedContactName,
      suggestedPhoneE164: parsed.suggestedPhoneE164,
      senders: parsed.senders,
      messageCount: parsed.messageCount,
      attachmentCount: parsed.attachmentCount,
      missingAttachmentCount: parsed.missingAttachmentCount,
      startedAt: parsed.startedAt?.toISOString() ?? null,
      endedAt: parsed.endedAt?.toISOString() ?? null,
      mapping: null,
    };
  }

  private batchPath(companyId: string, batchId: string): string {
    assertUuid(companyId, 'companyId');
    assertUuid(batchId, 'batchId');
    const path = resolve(this.root, 'history-batches', companyId, batchId);
    assertInside(this.root, path);
    return path;
  }

  private manifestPath(companyId: string, batchId: string): string {
    return resolve(this.batchPath(companyId, batchId), MANIFEST_FILE);
  }

  private async tryReadManifest(
    companyId: string,
    batchId: string,
  ): Promise<StoredManifest | null> {
    try {
      return await this.readManifest(companyId, batchId);
    } catch (error) {
      if ((error as { code?: string }).code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  private async readManifest(
    companyId: string,
    batchId: string,
  ): Promise<StoredManifest> {
    let content: string;
    try {
      content = await readFile(this.manifestPath(companyId, batchId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw notFound('Lote de importação');
      }
      throw error;
    }
    let manifest: StoredManifest;
    try {
      manifest = JSON.parse(content) as StoredManifest;
    } catch {
      throw validationError('O lote de importação está corrompido.');
    }
    if (
      manifest.schemaVersion !== MANIFEST_VERSION ||
      manifest.id !== batchId ||
      manifest.companyId !== companyId ||
      !Array.isArray(manifest.archives)
    ) {
      throw validationError('O lote de importação é inválido.');
    }
    if (
      new Date(manifest.expiresAt) < new Date() &&
      manifest.status === 'draft'
    ) {
      throw validationError('Este lote expirou. Inicie uma nova importação.');
    }
    return manifest;
  }

  private async writeManifest(manifest: StoredManifest): Promise<void> {
    const directory = this.batchPath(manifest.companyId, manifest.id);
    await mkdir(directory, { recursive: true });
    const destination = this.manifestPath(manifest.companyId, manifest.id);
    const temporary = resolve(
      directory,
      `${MANIFEST_FILE}.${randomUUID()}.tmp`,
    );
    assertInside(directory, temporary);
    await writeFile(temporary, JSON.stringify(manifest), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, destination);
  }

  private async withBatchLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.locks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}
