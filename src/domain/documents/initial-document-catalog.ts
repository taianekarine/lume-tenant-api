import type {
  DocumentRequestContext,
  DocumentRequirement,
} from './document-workflow';

export interface InitialDocumentType {
  readonly code: string;
  readonly name: string;
  readonly expires?: boolean;
  readonly renewalLeadDays?: number;
  readonly requiresFrontBack?: boolean;
  readonly allowsMultiplePages?: boolean;
  readonly maxFiles?: number;
  readonly extractionFields?: readonly string[];
}

export const INITIAL_DOCUMENT_TYPES: readonly InitialDocumentType[] = [
  { code: 'photo-3x4', name: 'Foto 3x4 recente' },
  {
    code: 'marriage-certificate',
    name: 'Certidão de casamento',
    allowsMultiplePages: true,
    maxFiles: 4,
  },
  {
    code: 'child-birth-certificate',
    name: 'Certidão de nascimento dos filhos',
    allowsMultiplePages: true,
    maxFiles: 12,
  },
  {
    code: 'child-vaccination-card',
    name: 'Carteira de vacinação dos filhos',
    allowsMultiplePages: true,
    maxFiles: 12,
  },
  {
    code: 'child-school-statement',
    name: 'Atestado escolar dos filhos',
    allowsMultiplePages: true,
    maxFiles: 12,
  },
  {
    code: 'child-identification',
    name: 'RG e CPF dos filhos',
    requiresFrontBack: true,
    allowsMultiplePages: true,
    maxFiles: 24,
  },
  { code: 'pis-card', name: 'Cartão do PIS/PASEP/NIT' },
  {
    code: 'voter-registration',
    name: 'Título de eleitor',
    requiresFrontBack: true,
    maxFiles: 2,
  },
  { code: 'proof-of-address', name: 'Comprovante de residência atual' },
  { code: 'cpf', name: 'CPF' },
  { code: 'rg', name: 'RG', requiresFrontBack: true, maxFiles: 2 },
  {
    code: 'ctps',
    name: 'CTPS — Carteira de Trabalho',
    allowsMultiplePages: true,
    maxFiles: 12,
  },
  {
    code: 'cnh',
    name: 'CNH — Carteira Nacional de Habilitação',
    expires: true,
    renewalLeadDays: 60,
    requiresFrontBack: true,
    maxFiles: 2,
  },
  {
    code: 'state-criminal-clearance',
    name: 'Certidão negativa criminal estadual',
    expires: true,
    renewalLeadDays: 30,
  },
  {
    code: 'civil-clearance',
    name: 'Certidão negativa de distribuição civil',
    expires: true,
    renewalLeadDays: 30,
  },
  {
    code: 'ambiguous-federal-state-clearance',
    name: 'Certidão negativa de distribuição federal (estadual) — validação pendente',
    expires: true,
    renewalLeadDays: 30,
  },
  {
    code: 'military-certificate',
    name: 'Certificado de alistamento militar ou reservista',
  },
  {
    code: 'spouse-identification',
    name: 'Documentos pessoais do cônjuge',
    requiresFrontBack: true,
    allowsMultiplePages: true,
    maxFiles: 4,
  },
  {
    code: 'vaccination-card',
    name: 'Cartão de vacinação atualizado',
    allowsMultiplePages: true,
    maxFiles: 8,
  },
  {
    code: 'passenger-transport-course',
    name: 'Certificado do Curso de Transporte Coletivo de Passageiros',
    expires: true,
    renewalLeadDays: 60,
  },
  {
    code: 'driver-license-record',
    name: 'Prontuário ou certidão de nada consta da CNH',
    expires: true,
    renewalLeadDays: 30,
  },
  {
    code: 'municipal-debt-clearance',
    name: 'Certidão negativa de débito municipal',
    expires: true,
    renewalLeadDays: 30,
  },
];

interface InitialChecklistItem {
  readonly documentTypeCode: string;
  readonly requirement?: DocumentRequirement;
  readonly instructions?: string;
  readonly condition?: Readonly<Record<string, unknown>>;
}

export interface InitialChecklist {
  readonly code: string;
  readonly name: string;
  readonly context: DocumentRequestContext;
  readonly requiresOriginals?: boolean;
  readonly items: readonly InitialChecklistItem[];
}

const familyConditions = {
  marriage: { field: 'maritalStatus', operator: 'equals', value: 'married' },
  childrenUnder14: { field: 'childrenAges', operator: 'some-lte', value: 13 },
  childrenUnder7: { field: 'childrenAges', operator: 'some-lte', value: 6 },
  childrenSchool: {
    field: 'childrenAges',
    operator: 'some-between',
    value: [7, 16],
  },
  spouse: { field: 'hasSpouse', operator: 'equals', value: true },
  military: {
    field: 'militaryCertificateApplicable',
    operator: 'equals',
    value: true,
  },
} as const;

const commonItems: readonly InitialChecklistItem[] = [
  { documentTypeCode: 'photo-3x4' },
  {
    documentTypeCode: 'marriage-certificate',
    requirement: 'conditional',
    condition: familyConditions.marriage,
  },
  {
    documentTypeCode: 'child-birth-certificate',
    requirement: 'conditional',
    condition: familyConditions.childrenUnder14,
  },
  {
    documentTypeCode: 'child-vaccination-card',
    requirement: 'conditional',
    condition: familyConditions.childrenUnder7,
  },
  {
    documentTypeCode: 'child-school-statement',
    requirement: 'conditional',
    condition: familyConditions.childrenSchool,
  },
  { documentTypeCode: 'pis-card' },
  { documentTypeCode: 'voter-registration' },
  { documentTypeCode: 'proof-of-address' },
  { documentTypeCode: 'cpf' },
  { documentTypeCode: 'rg' },
  { documentTypeCode: 'ctps' },
  { documentTypeCode: 'cnh' },
  {
    documentTypeCode: 'military-certificate',
    requirement: 'conditional',
    condition: familyConditions.military,
  },
  {
    documentTypeCode: 'spouse-identification',
    requirement: 'conditional',
    condition: familyConditions.spouse,
  },
];

export const INITIAL_DOCUMENT_CHECKLISTS: readonly InitialChecklist[] = [
  {
    code: 'admission-general',
    name: 'Documentação geral para registro',
    context: 'admission',
    items: [
      ...commonItems.slice(0, 5),
      {
        documentTypeCode: 'child-identification',
        requirement: 'conditional',
        condition: { field: 'hasChildren', operator: 'equals', value: true },
      },
      ...commonItems.slice(5),
      { documentTypeCode: 'state-criminal-clearance' },
      { documentTypeCode: 'civil-clearance' },
    ],
  },
  {
    code: 'admission-administrative',
    name: 'Documentação para registro administrativo',
    context: 'admission',
    items: [
      ...commonItems,
      { documentTypeCode: 'civil-clearance' },
      {
        documentTypeCode: 'ambiguous-federal-state-clearance',
        requirement: 'conditional',
        instructions:
          'PENDÊNCIA: RH/DP deve validar qual certidão é efetivamente exigida antes de ativar este item.',
        condition: { field: 'hrValidation', operator: 'required', value: true },
      },
    ],
  },
  {
    code: 'admission-driver',
    name: 'Documentação para registro de motorista',
    context: 'admission',
    requiresOriginals: true,
    items: [
      ...commonItems.slice(0, 5),
      {
        documentTypeCode: 'child-identification',
        requirement: 'conditional',
        condition: { field: 'hasChildren', operator: 'equals', value: true },
      },
      ...commonItems.slice(5, 11),
      { documentTypeCode: 'vaccination-card' },
      {
        documentTypeCode: 'cnh',
        instructions:
          'Exigir categoria D, EAR e registro do curso de transporte de passageiros.',
      },
      { documentTypeCode: 'passenger-transport-course' },
      { documentTypeCode: 'state-criminal-clearance' },
      { documentTypeCode: 'civil-clearance' },
      { documentTypeCode: 'driver-license-record' },
      ...commonItems.slice(12),
      { documentTypeCode: 'municipal-debt-clearance' },
    ],
  },
];
