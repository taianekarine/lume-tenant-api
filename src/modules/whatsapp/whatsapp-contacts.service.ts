import { Injectable } from '@nestjs/common';

import {
  conflict,
  notFound,
  validationError,
} from '../../core/errors/app-error';
import {
  formatWhatsAppPhone,
  normalizeWhatsAppPhone,
  onlyDigits,
  whatsAppPhoneAliases,
} from '../../shared/utils/normalization';
import { PrismaService } from '../../infra/database/prisma/prisma.service';
import type {
  SaveWhatsAppContactDto,
  WhatsAppContactListQueryDto,
} from './dto/whatsapp-contacts.dto';

const MAXIMUM_CONTACT_CSV_BYTES = 10 * 1024 * 1024;
const CONTACT_IMPORT_CHUNK_SIZE = 250;

interface ParsedContact {
  readonly phoneNormalized: string;
  readonly phoneDisplay: string;
  readonly displayName: string;
  readonly nameNeedsReview: boolean;
}

export interface UploadedContactCsv {
  readonly originalname: string;
  readonly size: number;
  readonly buffer: Buffer;
}

function contactName(value: string): {
  displayName: string;
  needsReview: boolean;
} {
  const displayName = value
    .normalize('NFKC')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return {
    displayName,
    needsReview:
      !displayName ||
      /[?\uFFFD]/u.test(displayName) ||
      !/[\p{L}\p{N}]/u.test(displayName),
  };
}

function parseCsvRows(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (character === ',' && !quoted) {
      row.push(field);
      field = '';
      continue;
    }
    if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += character;
  }

  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  if (quoted) throw validationError('O arquivo CSV possui aspas não fechadas.');
  return rows;
}

function decodeCsv(content: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return new TextDecoder('windows-1252').decode(content);
  }
}

function valueFor(
  values: readonly string[],
  headers: ReadonlyMap<string, number>,
  candidates: readonly string[],
): string {
  for (const candidate of candidates) {
    const index = headers.get(candidate.toLocaleLowerCase('pt-BR'));
    if (index !== undefined) return values[index]?.trim() ?? '';
  }
  return '';
}

export function parseContactCsv(content: Buffer): {
  contacts: ParsedContact[];
  invalidPhones: number;
  duplicatePhones: number;
} {
  if (content.byteLength === 0)
    throw validationError('O arquivo CSV está vazio.');
  if (content.byteLength > MAXIMUM_CONTACT_CSV_BYTES) {
    throw validationError('O arquivo CSV ultrapassa o limite de 10 MB.');
  }

  const rows = parseCsvRows(decodeCsv(content).replace(/^\uFEFF/, ''));
  const header = rows.shift();
  if (!header) throw validationError('O arquivo CSV não possui cabeçalho.');
  const headers = new Map(
    header.map((value, index) => [
      value.trim().toLocaleLowerCase('pt-BR'),
      index,
    ]),
  );
  const phoneHeaders = header
    .map((value, index) => ({ value: value.trim(), index }))
    .filter(({ value }) =>
      /^(phone\s*\d*\s*-\s*value|phone|telefone|celular|mobile phone)$/i.test(
        value,
      ),
    );
  if (phoneHeaders.length === 0) {
    throw validationError(
      'O CSV não possui nenhuma coluna de telefone reconhecida.',
    );
  }

  const contacts = new Map<string, ParsedContact>();
  let invalidPhones = 0;
  let duplicatePhones = 0;
  for (const values of rows) {
    const composedName = [
      valueFor(values, headers, ['first name', 'primeiro nome']),
      valueFor(values, headers, ['middle name', 'nome do meio']),
      valueFor(values, headers, ['last name', 'sobrenome']),
    ]
      .filter(Boolean)
      .join(' ');
    const sourceName =
      composedName ||
      valueFor(values, headers, [
        'name',
        'nome',
        'file as',
        'nickname',
        'apelido',
      ]);
    const normalizedName = contactName(sourceName);

    for (const { index } of phoneHeaders) {
      const phones = (values[index] ?? '')
        .split(/\s*:::\s*/)
        .map((phone) => phone.trim())
        .filter(Boolean);
      for (const phone of phones) {
        try {
          const phoneNormalized = normalizeWhatsAppPhone(phone);
          const phoneDisplay = formatWhatsAppPhone(phoneNormalized);
          const candidate: ParsedContact = {
            phoneNormalized,
            phoneDisplay,
            displayName: normalizedName.displayName || phoneDisplay,
            nameNeedsReview: normalizedName.needsReview,
          };
          const previous = contacts.get(phoneNormalized);
          if (previous) {
            duplicatePhones += 1;
            if (previous.nameNeedsReview && !candidate.nameNeedsReview) {
              contacts.set(phoneNormalized, candidate);
            }
          } else {
            contacts.set(phoneNormalized, candidate);
          }
        } catch {
          invalidPhones += 1;
        }
      }
    }
  }

  if (contacts.size === 0) {
    throw validationError('Nenhum telefone válido foi encontrado no CSV.');
  }
  return { contacts: [...contacts.values()], invalidPhones, duplicatePhones };
}

function presentContact(contact: {
  id: string;
  phoneNormalized: string;
  phoneDisplay: string;
  displayName: string | null;
  nameNeedsReview: boolean;
  profilePictureUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: contact.id,
    name: contact.displayName ?? contact.phoneDisplay,
    phone: contact.phoneDisplay,
    nameNeedsReview: contact.nameNeedsReview,
    profilePictureUrl: contact.profilePictureUrl,
    createdAt: contact.createdAt.toISOString(),
    updatedAt: contact.updatedAt.toISOString(),
  };
}

@Injectable()
export class WhatsAppContactsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(companyId: string, query: WhatsAppContactListQueryDto) {
    const phoneSearch = query.search ? onlyDigits(query.search) : '';
    const where = {
      companyId,
      isSaved: true,
      ...(query.needsReview === undefined
        ? {}
        : { nameNeedsReview: query.needsReview }),
      ...(query.search
        ? {
            OR: [
              {
                displayName: {
                  contains: query.search,
                  mode: 'insensitive' as const,
                },
              },
              { phoneDisplay: { contains: query.search } },
              ...(phoneSearch
                ? [{ phoneNormalized: { contains: phoneSearch } }]
                : []),
            ],
          }
        : {}),
    };
    const [total, reviewTotal, contacts] = await this.prisma.$transaction([
      this.prisma.whatsAppContact.count({ where }),
      this.prisma.whatsAppContact.count({
        where: { companyId, isSaved: true, nameNeedsReview: true },
      }),
      this.prisma.whatsAppContact.findMany({
        where,
        orderBy: [{ nameNeedsReview: 'desc' }, { displayName: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          phoneNormalized: true,
          phoneDisplay: true,
          displayName: true,
          nameNeedsReview: true,
          profilePictureUrl: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);
    return {
      contacts: contacts.map(presentContact),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      reviewTotal,
    };
  }

  async create(companyId: string, input: SaveWhatsAppContactDto) {
    const phoneNormalized = this.normalizePhone(input.phone);
    const phoneDisplay = formatWhatsAppPhone(phoneNormalized);
    const name = contactName(input.name);
    if (!name.displayName) throw validationError('Informe o nome do contato.');
    const existing = await this.prisma.whatsAppContact.findUnique({
      where: { companyId_phoneNormalized: { companyId, phoneNormalized } },
      select: { id: true, isSaved: true },
    });
    if (existing?.isSaved) {
      throw conflict('Já existe um contato salvo com este telefone.');
    }
    const contact = await this.prisma.whatsAppContact.upsert({
      where: { companyId_phoneNormalized: { companyId, phoneNormalized } },
      create: {
        companyId,
        phoneNormalized,
        phoneDisplay,
        displayName: name.displayName,
        isSaved: true,
        nameNeedsReview: name.needsReview,
      },
      update: {
        phoneDisplay,
        displayName: name.displayName,
        isSaved: true,
        nameNeedsReview: name.needsReview,
      },
      select: {
        id: true,
        phoneNormalized: true,
        phoneDisplay: true,
        displayName: true,
        nameNeedsReview: true,
        profilePictureUrl: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    await this.updateEquivalentLegacyContacts(
      companyId,
      phoneNormalized,
      name.displayName,
      name.needsReview,
      contact.id,
    );
    return presentContact(contact);
  }

  async update(
    companyId: string,
    contactId: string,
    input: SaveWhatsAppContactDto,
  ) {
    const current = await this.savedContact(companyId, contactId);
    const phoneNormalized = this.normalizePhone(input.phone);
    const collision = await this.prisma.whatsAppContact.findUnique({
      where: { companyId_phoneNormalized: { companyId, phoneNormalized } },
      select: { id: true },
    });
    if (collision && collision.id !== current.id) {
      throw conflict('Outro contato já utiliza este telefone.');
    }
    const name = contactName(input.name);
    if (!name.displayName) throw validationError('Informe o nome do contato.');
    const contact = await this.prisma.whatsAppContact.update({
      where: { id_companyId: { id: contactId, companyId } },
      data: {
        phoneNormalized,
        phoneDisplay: formatWhatsAppPhone(phoneNormalized),
        displayName: name.displayName,
        nameNeedsReview: name.needsReview,
      },
      select: {
        id: true,
        phoneNormalized: true,
        phoneDisplay: true,
        displayName: true,
        nameNeedsReview: true,
        profilePictureUrl: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    await this.updateEquivalentLegacyContacts(
      companyId,
      phoneNormalized,
      name.displayName,
      name.needsReview,
      contact.id,
    );
    return presentContact(contact);
  }

  async delete(companyId: string, contactId: string) {
    const contact = await this.savedContact(companyId, contactId);
    const [conversations, messages] = await this.prisma.$transaction([
      this.prisma.whatsAppConversation.count({
        where: { companyId, contactId },
      }),
      this.prisma.whatsAppMessage.count({ where: { companyId, contactId } }),
    ]);
    if (conversations + messages === 0) {
      await this.prisma.whatsAppContact.delete({
        where: { id_companyId: { id: contactId, companyId } },
      });
    } else {
      await this.prisma.whatsAppContact.update({
        where: { id_companyId: { id: contactId, companyId } },
        data: {
          isSaved: false,
          nameNeedsReview: false,
          displayName: contact.phoneDisplay,
        },
      });
    }
    return { deleted: true };
  }

  async importCsv(companyId: string, file: UploadedContactCsv | undefined) {
    if (
      !file?.buffer ||
      !file.originalname.toLocaleLowerCase('pt-BR').endsWith('.csv')
    ) {
      throw validationError('Selecione um arquivo CSV válido.');
    }
    const parsed = parseContactCsv(file.buffer);
    const phones = [
      ...new Set(
        parsed.contacts.flatMap((contact) =>
          whatsAppPhoneAliases(contact.phoneNormalized),
        ),
      ),
    ];
    const existing = await this.prisma.whatsAppContact.findMany({
      where: { companyId, phoneNormalized: { in: phones } },
      select: { id: true, phoneNormalized: true },
    });
    const existingByPhone = new Map(
      existing.map((contact) => [contact.phoneNormalized, contact.id]),
    );
    const contactsToCreate = parsed.contacts.filter(
      (contact) => !existingByPhone.has(contact.phoneNormalized),
    );
    const contactsToUpdate = parsed.contacts.filter((contact) =>
      existingByPhone.has(contact.phoneNormalized),
    );
    for (
      let index = 0;
      index < contactsToCreate.length;
      index += CONTACT_IMPORT_CHUNK_SIZE
    ) {
      await this.prisma.whatsAppContact.createMany({
        data: contactsToCreate
          .slice(index, index + CONTACT_IMPORT_CHUNK_SIZE)
          .map((contact) => ({ companyId, ...contact, isSaved: true })),
        skipDuplicates: true,
      });
    }
    for (
      let index = 0;
      index < contactsToUpdate.length;
      index += CONTACT_IMPORT_CHUNK_SIZE
    ) {
      const chunk = contactsToUpdate.slice(
        index,
        index + CONTACT_IMPORT_CHUNK_SIZE,
      );
      await this.prisma.$transaction(
        chunk.flatMap((contact) => [
          this.prisma.whatsAppContact.update({
            where: {
              id_companyId: {
                id: existingByPhone.get(contact.phoneNormalized)!,
                companyId,
              },
            },
            data: { ...contact, isSaved: true },
          }),
          this.updateEquivalentLegacyContactsOperation(
            companyId,
            contact.phoneNormalized,
            contact.displayName,
            contact.nameNeedsReview,
            existingByPhone.get(contact.phoneNormalized),
          ),
        ]),
      );
    }
    for (
      let index = 0;
      index < contactsToCreate.length;
      index += CONTACT_IMPORT_CHUNK_SIZE
    ) {
      const chunk = contactsToCreate.slice(
        index,
        index + CONTACT_IMPORT_CHUNK_SIZE,
      );
      await this.prisma.$transaction(
        chunk.map((contact) =>
          this.updateEquivalentLegacyContactsOperation(
            companyId,
            contact.phoneNormalized,
            contact.displayName,
            contact.nameNeedsReview,
          ),
        ),
      );
    }
    return {
      imported: parsed.contacts.length,
      created: contactsToCreate.length,
      updated: contactsToUpdate.length,
      needsReview: parsed.contacts.filter((contact) => contact.nameNeedsReview)
        .length,
      invalidPhones: parsed.invalidPhones,
      duplicatePhones: parsed.duplicatePhones,
    };
  }

  private normalizePhone(value: string): string {
    try {
      return normalizeWhatsAppPhone(value);
    } catch {
      throw validationError('Informe um telefone válido com DDD.');
    }
  }

  private updateEquivalentLegacyContactsOperation(
    companyId: string,
    phoneNormalized: string,
    displayName: string,
    nameNeedsReview: boolean,
    canonicalContactId?: string,
  ) {
    const aliases = whatsAppPhoneAliases(phoneNormalized).filter(
      (phone) => phone !== phoneNormalized,
    );
    return this.prisma.whatsAppContact.updateMany({
      where: {
        companyId,
        phoneNormalized: { in: aliases },
        ...(canonicalContactId ? { id: { not: canonicalContactId } } : {}),
      },
      data: {
        displayName,
        nameNeedsReview,
        isSaved: false,
      },
    });
  }

  private async updateEquivalentLegacyContacts(
    companyId: string,
    phoneNormalized: string,
    displayName: string,
    nameNeedsReview: boolean,
    canonicalContactId: string,
  ): Promise<void> {
    await this.updateEquivalentLegacyContactsOperation(
      companyId,
      phoneNormalized,
      displayName,
      nameNeedsReview,
      canonicalContactId,
    );
  }

  private async savedContact(companyId: string, contactId: string) {
    const contact = await this.prisma.whatsAppContact.findFirst({
      where: { id: contactId, companyId, isSaved: true },
      select: { id: true, phoneDisplay: true },
    });
    if (!contact) throw notFound('Contato não encontrado.');
    return contact;
  }
}
