import { describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../../infra/database/prisma/prisma.service';
import {
  parseContactCsv,
  WhatsAppContactsService,
} from './whatsapp-contacts.service';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const CONTACT_ID = '22222222-2222-4222-8222-222222222222';

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: CONTACT_ID,
    phoneNormalized: '5534988687758',
    phoneDisplay: '(34) 98868-7758',
    displayName: 'Maria da Silva',
    nameNeedsReview: false,
    profilePictureUrl: null,
    createdAt: new Date('2026-08-18T12:00:00.000Z'),
    updatedAt: new Date('2026-08-18T12:00:00.000Z'),
    ...overrides,
  };
}

function mockPrisma() {
  const whatsAppContact = {
    count: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    createMany: vi.fn(),
    delete: vi.fn(),
  };
  const whatsAppConversation = { count: vi.fn() };
  const whatsAppMessage = { count: vi.fn() };
  const transaction = vi.fn(async (operations: readonly unknown[]) =>
    Promise.all(operations),
  );
  const prisma = {
    whatsAppContact,
    whatsAppConversation,
    whatsAppMessage,
    $transaction: transaction,
  };
  return {
    prisma: prisma as unknown as PrismaService,
    whatsAppContact,
    whatsAppConversation,
    whatsAppMessage,
    transaction,
  };
}

describe('parseContactCsv', () => {
  it('lê exportação do Google, normaliza caracteres e reúne todos os telefones', () => {
    const csv = [
      'First Name,Middle Name,Last Name,Phone 1 - Value,Phone 2 - Value',
      '𝐉𝐮𝐧𝐢𝐨,da,Silva,+55 34 98868-7758,34 8868-7758',
      '?,,,(34) 3223-6060,9254',
    ].join('\r\n');

    expect(parseContactCsv(Buffer.from(csv, 'utf8'))).toEqual({
      contacts: [
        {
          phoneNormalized: '5534988687758',
          phoneDisplay: '(34) 98868-7758',
          displayName: 'Junio da Silva',
          nameNeedsReview: false,
        },
        {
          phoneNormalized: '553432236060',
          phoneDisplay: '(34) 3223-6060',
          displayName: '?',
          nameNeedsReview: true,
        },
      ],
      invalidPhones: 1,
      duplicatePhones: 1,
    });
  });

  it('aceita cabeçalhos simples em português e sinaliza nome vazio', () => {
    const parsed = parseContactCsv(
      Buffer.from('Nome,Telefone\n,(34) 99971-3456', 'utf8'),
    );
    expect(parsed.contacts[0]).toMatchObject({
      displayName: '(34) 99971-3456',
      nameNeedsReview: true,
    });
  });

  it('importa vários telefones guardados na mesma célula pelo Google', () => {
    const result = parseContactCsv(
      Buffer.from(
        'Name,Phone 1 - Value\nMaria,"(34) 98888-1111 ::: (34) 97777-2222"',
      ),
    );

    expect(result.contacts).toHaveLength(2);
    expect(result.invalidPhones).toBe(0);
  });

  it('rejeita arquivo vazio, sem telefone, sem registros válidos ou malformado', () => {
    expect(() => parseContactCsv(Buffer.alloc(0))).toThrow('está vazio');
    expect(() => parseContactCsv(Buffer.from('Nome\nMaria'))).toThrow(
      'coluna de telefone',
    );
    expect(() =>
      parseContactCsv(Buffer.from('Nome,Telefone\nMaria,9254')),
    ).toThrow('Nenhum telefone válido');
    expect(() =>
      parseContactCsv(Buffer.from('Nome,Telefone\n"Maria,(34) 99971-3456')),
    ).toThrow('aspas não fechadas');
  });
});

describe('WhatsAppContactsService', () => {
  it('lista somente contatos salvos com paginação e total de revisão', async () => {
    const mocks = mockPrisma();
    mocks.whatsAppContact.count.mockReturnValueOnce(Promise.resolve(1));
    mocks.whatsAppContact.count.mockReturnValueOnce(Promise.resolve(1));
    mocks.whatsAppContact.findMany.mockReturnValue(Promise.resolve([row()]));
    const service = new WhatsAppContactsService(mocks.prisma);

    await expect(
      service.list(COMPANY_ID, {
        page: 1,
        pageSize: 25,
        search: 'Maria 98868',
        needsReview: true,
      }),
    ).resolves.toMatchObject({
      total: 1,
      totalPages: 1,
      reviewTotal: 1,
      contacts: [{ name: 'Maria da Silva', phone: '(34) 98868-7758' }],
    });
    expect(mocks.whatsAppContact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isSaved: true,
          nameNeedsReview: true,
        }),
      }),
    );
  });

  it('salva novo contato e promove contato já conhecido pelo WhatsApp', async () => {
    const mocks = mockPrisma();
    mocks.whatsAppContact.findUnique.mockResolvedValueOnce({
      id: CONTACT_ID,
      isSaved: false,
    });
    mocks.whatsAppContact.upsert.mockResolvedValue(row());
    const service = new WhatsAppContactsService(mocks.prisma);

    await expect(
      service.create(COMPANY_ID, {
        name: ' Maria da Silva ',
        phone: '(34) 8868-7758',
      }),
    ).resolves.toMatchObject({ name: 'Maria da Silva' });
    expect(mocks.whatsAppContact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ isSaved: true }),
      }),
    );
  });

  it('impede duplicidade e telefone inválido ao salvar', async () => {
    const mocks = mockPrisma();
    const service = new WhatsAppContactsService(mocks.prisma);
    mocks.whatsAppContact.findUnique.mockResolvedValue({
      id: CONTACT_ID,
      isSaved: true,
    });
    await expect(
      service.create(COMPANY_ID, {
        name: 'Maria',
        phone: '(34) 98868-7758',
      }),
    ).rejects.toThrow('Já existe');
    await expect(
      service.create(COMPANY_ID, { name: 'Maria', phone: '9254' }),
    ).rejects.toThrow('telefone válido');
  });

  it('edita nome e telefone, removendo a pendência do nome corrigido', async () => {
    const mocks = mockPrisma();
    mocks.whatsAppContact.findFirst.mockResolvedValue({
      id: CONTACT_ID,
      phoneDisplay: '(34) 98868-7758',
    });
    mocks.whatsAppContact.findUnique.mockResolvedValue(null);
    mocks.whatsAppContact.update.mockResolvedValue(
      row({ nameNeedsReview: false }),
    );
    const service = new WhatsAppContactsService(mocks.prisma);

    await expect(
      service.update(COMPANY_ID, CONTACT_ID, {
        name: 'Maria da Silva',
        phone: '(34) 98868-7758',
      }),
    ).resolves.toMatchObject({ nameNeedsReview: false });
  });

  it('impede que a edição reutilize o telefone de outro contato', async () => {
    const mocks = mockPrisma();
    mocks.whatsAppContact.findFirst.mockResolvedValue({
      id: CONTACT_ID,
      phoneDisplay: '(34) 98868-7758',
    });
    mocks.whatsAppContact.findUnique.mockResolvedValue({ id: 'outro' });
    const service = new WhatsAppContactsService(mocks.prisma);
    await expect(
      service.update(COMPANY_ID, CONTACT_ID, {
        name: 'Maria',
        phone: '(34) 99971-3456',
      }),
    ).rejects.toThrow('Outro contato');
  });

  it('exclui contato sem histórico e apenas o remove da agenda quando há conversa', async () => {
    const first = mockPrisma();
    first.whatsAppContact.findFirst.mockResolvedValue({
      id: CONTACT_ID,
      phoneDisplay: '(34) 98868-7758',
    });
    first.whatsAppConversation.count.mockReturnValue(Promise.resolve(0));
    first.whatsAppMessage.count.mockReturnValue(Promise.resolve(0));
    const firstService = new WhatsAppContactsService(first.prisma);
    await expect(firstService.delete(COMPANY_ID, CONTACT_ID)).resolves.toEqual({
      deleted: true,
    });
    expect(first.whatsAppContact.delete).toHaveBeenCalled();

    const second = mockPrisma();
    second.whatsAppContact.findFirst.mockResolvedValue({
      id: CONTACT_ID,
      phoneDisplay: '(34) 98868-7758',
    });
    second.whatsAppConversation.count.mockReturnValue(Promise.resolve(1));
    second.whatsAppMessage.count.mockReturnValue(Promise.resolve(10));
    const secondService = new WhatsAppContactsService(second.prisma);
    await secondService.delete(COMPANY_ID, CONTACT_ID);
    expect(second.whatsAppContact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isSaved: false }),
      }),
    );
  });

  it('importa CSV atualizando existentes e criando novos em lote', async () => {
    const mocks = mockPrisma();
    mocks.whatsAppContact.findMany.mockResolvedValue([
      { id: CONTACT_ID, phoneNormalized: '5534988687758' },
    ]);
    mocks.whatsAppContact.createMany.mockResolvedValue({ count: 1 });
    mocks.whatsAppContact.update.mockResolvedValue(row());
    const service = new WhatsAppContactsService(mocks.prisma);
    const csv = [
      'Nome,Telefone',
      'Maria,(34) 98868-7758',
      '?,(34) 3223-6060',
    ].join('\n');

    await expect(
      service.importCsv(COMPANY_ID, {
        originalname: 'contatos.csv',
        size: Buffer.byteLength(csv),
        buffer: Buffer.from(csv),
      }),
    ).resolves.toEqual({
      imported: 2,
      created: 1,
      updated: 1,
      needsReview: 1,
      invalidPhones: 0,
      duplicatePhones: 0,
    });
    expect(mocks.whatsAppContact.createMany).toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalled();
  });

  it('propaga o nome para conversas ligadas ao celular sem o nono dígito', async () => {
    const mocks = mockPrisma();
    mocks.whatsAppContact.findMany.mockResolvedValue([
      { id: CONTACT_ID, phoneNormalized: '5534988687758' },
      {
        id: '33333333-3333-4333-8333-333333333333',
        phoneNormalized: '553488687758',
      },
    ]);
    mocks.whatsAppContact.update.mockResolvedValue(row());
    mocks.whatsAppContact.updateMany.mockResolvedValue({ count: 1 });
    const service = new WhatsAppContactsService(mocks.prisma);
    const csv = 'Nome,Telefone\nMaria da Silva,(34) 98868-7758';

    await service.importCsv(COMPANY_ID, {
      originalname: 'contatos.csv',
      size: Buffer.byteLength(csv),
      buffer: Buffer.from(csv),
    });

    expect(mocks.whatsAppContact.updateMany).toHaveBeenCalledWith({
      where: {
        companyId: COMPANY_ID,
        phoneNormalized: { in: ['553488687758'] },
        id: { not: CONTACT_ID },
      },
      data: {
        displayName: 'Maria da Silva',
        nameNeedsReview: false,
        isSaved: false,
      },
    });
  });

  it('rejeita importação sem arquivo CSV e contato inexistente', async () => {
    const mocks = mockPrisma();
    const service = new WhatsAppContactsService(mocks.prisma);
    await expect(service.importCsv(COMPANY_ID, undefined)).rejects.toThrow(
      'arquivo CSV válido',
    );
    mocks.whatsAppContact.findFirst.mockResolvedValue(null);
    await expect(service.delete(COMPANY_ID, CONTACT_ID)).rejects.toThrow(
      'Contato não encontrado',
    );
  });
});
