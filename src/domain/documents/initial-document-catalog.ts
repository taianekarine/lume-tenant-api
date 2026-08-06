import type {
  DocumentRequestContext,
  DocumentRequirement,
} from './document-workflow';

export interface InitialExtractionField {
  readonly key: string;
  readonly label: string;
  readonly type?: 'text' | 'date' | 'boolean' | 'number' | 'list';
  readonly multiple?: boolean;
}

export interface InitialDocumentType {
  readonly code: string;
  readonly name: string;
  readonly expires?: boolean;
  readonly renewalLeadDays?: number;
  readonly requiresFrontBack?: boolean;
  readonly allowsMultiplePages?: boolean;
  readonly maxFiles?: number;
  readonly extractionFields?: readonly InitialExtractionField[];
}

const fields = (...definitions: readonly InitialExtractionField[]) =>
  definitions;
const repeatedFields = (...definitions: readonly InitialExtractionField[]) =>
  definitions.map((definition) => ({ ...definition, multiple: true }));
const personFields = fields(
  { key: 'fullName', label: 'Nome completo' },
  { key: 'cpf', label: 'CPF' },
  { key: 'birthDate', label: 'Data de nascimento', type: 'date' },
);
const certificateFields = fields(
  { key: 'holderName', label: 'Nome do titular' },
  { key: 'cpf', label: 'CPF' },
  { key: 'certificateType', label: 'Tipo da certidão' },
  { key: 'issuer', label: 'Órgão emissor' },
  { key: 'jurisdiction', label: 'Jurisdição' },
  { key: 'issuedAt', label: 'Data de emissão', type: 'date' },
  { key: 'validUntil', label: 'Data de validade', type: 'date' },
  { key: 'result', label: 'Resultado' },
  { key: 'validationCode', label: 'Código de validação' },
);

export const INITIAL_DOCUMENT_TYPES: readonly InitialDocumentType[] = [
  { code: 'photo-3x4', name: 'Foto 3x4 recente' },
  {
    code: 'marriage-certificate',
    name: 'Certidão de casamento',
    allowsMultiplePages: true,
    maxFiles: 4,
    extractionFields: fields(
      { key: 'spouseNames', label: 'Nomes dos cônjuges', multiple: true },
      { key: 'previousNames', label: 'Nomes anteriores', multiple: true },
      { key: 'marriageDate', label: 'Data do casamento', type: 'date' },
      { key: 'propertyRegime', label: 'Regime de bens' },
      { key: 'registration', label: 'Matrícula da certidão' },
      { key: 'registryOffice', label: 'Cartório' },
      { key: 'city', label: 'Município' },
      { key: 'state', label: 'UF' },
    ),
  },
  {
    code: 'child-birth-certificate',
    name: 'Certidão de nascimento dos filhos',
    allowsMultiplePages: true,
    maxFiles: 12,
    extractionFields: repeatedFields(
      { key: 'childName', label: 'Nome da criança' },
      { key: 'birthDate', label: 'Data de nascimento', type: 'date' },
      { key: 'parentage', label: 'Filiação', multiple: true },
      { key: 'registration', label: 'Matrícula da certidão' },
      { key: 'registryOffice', label: 'Cartório' },
      { key: 'city', label: 'Município' },
      { key: 'state', label: 'UF' },
    ),
  },
  {
    code: 'child-vaccination-card',
    name: 'Carteira de vacinação dos filhos',
    allowsMultiplePages: true,
    maxFiles: 12,
    extractionFields: repeatedFields(
      ...personFields,
      { key: 'issuer', label: 'Unidade emissora' },
      { key: 'issuedAt', label: 'Data de emissão', type: 'date' },
      { key: 'referencePeriod', label: 'Período de referência' },
      { key: 'requirementInformation', label: 'Informações para conferência' },
    ),
  },
  {
    code: 'child-school-statement',
    name: 'Atestado escolar dos filhos',
    allowsMultiplePages: true,
    maxFiles: 12,
    extractionFields: repeatedFields(
      ...personFields,
      { key: 'institution', label: 'Instituição' },
      { key: 'issuedAt', label: 'Data de emissão', type: 'date' },
      { key: 'referencePeriod', label: 'Período de referência' },
      { key: 'requirementInformation', label: 'Informações para conferência' },
    ),
  },
  {
    code: 'child-identification',
    name: 'RG e CPF dos filhos',
    requiresFrontBack: true,
    allowsMultiplePages: true,
    maxFiles: 24,
    extractionFields: repeatedFields(
      { key: 'name', label: 'Nome' },
      { key: 'cpf', label: 'CPF' },
      { key: 'rg', label: 'RG' },
      { key: 'birthDate', label: 'Data de nascimento', type: 'date' },
      { key: 'relationship', label: 'Vínculo com o funcionário' },
      { key: 'validUntil', label: 'Validade', type: 'date' },
    ),
  },
  {
    code: 'pis-card',
    name: 'Cartão do PIS/PASEP/NIT',
    extractionFields: fields(...personFields, {
      key: 'pisPasepNit',
      label: 'PIS/PASEP/NIT',
    }),
  },
  {
    code: 'voter-registration',
    name: 'Título de eleitor',
    requiresFrontBack: true,
    maxFiles: 2,
    extractionFields: fields(
      ...personFields,
      { key: 'registrationNumber', label: 'Número do título' },
      { key: 'zone', label: 'Zona' },
      { key: 'section', label: 'Seção' },
      { key: 'city', label: 'Município' },
      { key: 'state', label: 'UF' },
    ),
  },
  {
    code: 'proof-of-address',
    name: 'Comprovante de residência atual',
    extractionFields: fields(
      { key: 'holderName', label: 'Nome do titular' },
      { key: 'street', label: 'Endereço' },
      { key: 'number', label: 'Número' },
      { key: 'complement', label: 'Complemento' },
      { key: 'district', label: 'Bairro' },
      { key: 'city', label: 'Município' },
      { key: 'state', label: 'UF' },
      { key: 'postalCode', label: 'CEP' },
      { key: 'issuedAt', label: 'Data de emissão ou referência', type: 'date' },
      { key: 'proofType', label: 'Tipo de comprovante' },
    ),
  },
  {
    code: 'cpf',
    name: 'CPF',
    extractionFields: fields(...personFields, {
      key: 'statusInformation',
      label: 'Situação ou informação disponível',
    }),
  },
  {
    code: 'rg',
    name: 'RG',
    requiresFrontBack: true,
    maxFiles: 2,
    extractionFields: fields(
      ...personFields,
      { key: 'rg', label: 'Número do RG' },
      { key: 'issuer', label: 'Órgão emissor' },
      { key: 'state', label: 'UF' },
      { key: 'issuedAt', label: 'Data de expedição', type: 'date' },
      { key: 'birthPlace', label: 'Naturalidade' },
      { key: 'parentage', label: 'Filiação', multiple: true },
    ),
  },
  {
    code: 'ctps',
    name: 'CTPS — Carteira de Trabalho',
    allowsMultiplePages: true,
    maxFiles: 12,
    extractionFields: fields(
      ...personFields,
      { key: 'pisPasepNit', label: 'PIS/PASEP/NIT' },
      { key: 'parentage', label: 'Filiação', multiple: true },
      { key: 'essentialInformation', label: 'Informações essenciais' },
    ),
  },
  {
    code: 'cnh',
    name: 'CNH — Carteira Nacional de Habilitação',
    expires: true,
    renewalLeadDays: 60,
    requiresFrontBack: true,
    maxFiles: 2,
    extractionFields: fields(
      ...personFields,
      { key: 'registrationNumber', label: 'Número de registro' },
      { key: 'category', label: 'Categoria' },
      { key: 'issuedAt', label: 'Data de emissão', type: 'date' },
      {
        key: 'firstLicenseAt',
        label: 'Data da primeira habilitação',
        type: 'date',
      },
      { key: 'validUntil', label: 'Data de validade', type: 'date' },
      { key: 'state', label: 'UF' },
      { key: 'ear', label: 'EAR', type: 'boolean' },
      { key: 'observations', label: 'Observações' },
      { key: 'registeredCourses', label: 'Cursos registrados', type: 'list' },
      { key: 'securityCode', label: 'Código de segurança ou identificador' },
    ),
  },
  {
    code: 'state-criminal-clearance',
    name: 'Certidão negativa criminal estadual',
    expires: true,
    renewalLeadDays: 30,
    extractionFields: certificateFields,
  },
  {
    code: 'civil-clearance',
    name: 'Certidão negativa de distribuição civil',
    expires: true,
    renewalLeadDays: 30,
    extractionFields: certificateFields,
  },
  {
    code: 'ambiguous-federal-state-clearance',
    name: 'Certidão negativa de distribuição federal (estadual) — validação pendente',
    expires: true,
    renewalLeadDays: 30,
    extractionFields: certificateFields,
  },
  {
    code: 'military-certificate',
    name: 'Certificado de alistamento militar ou reservista',
  },
  {
    code: 'spouse-identification',
    name: 'Documentos pessoais do cônjuge — RG e CPF',
    requiresFrontBack: true,
    allowsMultiplePages: true,
    maxFiles: 4,
    extractionFields: fields(
      ...personFields,
      { key: 'rg', label: 'RG' },
      { key: 'relationship', label: 'Vínculo com o funcionário' },
    ),
  },
  {
    code: 'vaccination-card',
    name: 'Cartão de vacinação atualizado',
    allowsMultiplePages: true,
    maxFiles: 8,
    extractionFields: fields(
      ...personFields,
      { key: 'issuer', label: 'Unidade emissora' },
      { key: 'issuedAt', label: 'Data de emissão', type: 'date' },
      { key: 'requirementInformation', label: 'Informações para conferência' },
    ),
  },
  {
    code: 'passenger-transport-course',
    name: 'Certificado do Curso de Transporte Coletivo de Passageiros',
    expires: true,
    renewalLeadDays: 60,
    extractionFields: fields(
      ...personFields,
      { key: 'courseName', label: 'Nome do curso' },
      { key: 'institution', label: 'Instituição emissora' },
      { key: 'workloadHours', label: 'Carga horária', type: 'number' },
      { key: 'completedAt', label: 'Data de conclusão', type: 'date' },
      { key: 'validUntil', label: 'Data de validade', type: 'date' },
      { key: 'certificateNumber', label: 'Número do certificado' },
    ),
  },
  {
    code: 'driver-license-record',
    name: 'Prontuário ou certidão de nada consta da CNH',
    expires: true,
    renewalLeadDays: 30,
    extractionFields: certificateFields,
  },
  {
    code: 'municipal-debt-clearance',
    name: 'Certidão negativa de débito municipal',
    expires: true,
    renewalLeadDays: 30,
    extractionFields: certificateFields,
  },
];

interface InitialChecklistItem {
  readonly documentTypeCode: string;
  readonly requirement?: DocumentRequirement;
  readonly instructions?: string;
  readonly condition?: Readonly<Record<string, unknown>>;
  readonly configOverrides?: Readonly<Record<string, unknown>>;
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
  {
    documentTypeCode: 'photo-3x4',
    configOverrides: { minFiles: 1, maxFiles: 1 },
  },
  {
    documentTypeCode: 'marriage-certificate',
    requirement: 'conditional',
    condition: familyConditions.marriage,
  },
  {
    documentTypeCode: 'child-birth-certificate',
    requirement: 'conditional',
    condition: familyConditions.childrenUnder14,
    configOverrides: { repeatableByDependent: true },
  },
  {
    documentTypeCode: 'child-vaccination-card',
    requirement: 'conditional',
    condition: familyConditions.childrenUnder7,
    configOverrides: { repeatableByDependent: true },
  },
  {
    documentTypeCode: 'child-school-statement',
    requirement: 'conditional',
    condition: familyConditions.childrenSchool,
    configOverrides: { repeatableByDependent: true },
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
    code: 'employee-documents-dynamic',
    name: 'Documentação personalizada do funcionário',
    context: 'admission',
    items: [
      {
        documentTypeCode: 'photo-3x4',
        configOverrides: { minFiles: 1, maxFiles: 1 },
      },
      { documentTypeCode: 'cpf' },
      { documentTypeCode: 'rg' },
      { documentTypeCode: 'ctps' },
      { documentTypeCode: 'cnh' },
      { documentTypeCode: 'proof-of-address' },
      { documentTypeCode: 'pis-card' },
      { documentTypeCode: 'voter-registration' },
      { documentTypeCode: 'state-criminal-clearance' },
      { documentTypeCode: 'civil-clearance' },
      {
        documentTypeCode: 'marriage-certificate',
        requirement: 'conditional',
        condition: { field: 'hasSpouse', operator: 'equals', value: true },
      },
      {
        documentTypeCode: 'spouse-identification',
        requirement: 'conditional',
        condition: { field: 'hasSpouse', operator: 'equals', value: true },
      },
      {
        documentTypeCode: 'child-birth-certificate',
        requirement: 'conditional',
        condition: {
          field: 'dependentCount',
          operator: 'greater-than',
          value: 0,
        },
        configOverrides: { repeatableByDependent: true },
      },
      {
        documentTypeCode: 'child-identification',
        requirement: 'conditional',
        condition: {
          field: 'dependentCount',
          operator: 'greater-than',
          value: 0,
        },
        configOverrides: { repeatableByDependent: true },
      },
      {
        documentTypeCode: 'child-vaccination-card',
        requirement: 'conditional',
        condition: {
          field: 'hasDependentUnder7',
          operator: 'equals',
          value: true,
        },
        configOverrides: { repeatableByDependent: true },
      },
      {
        documentTypeCode: 'child-school-statement',
        requirement: 'conditional',
        condition: {
          field: 'hasDependentSchoolAge',
          operator: 'equals',
          value: true,
        },
        configOverrides: { repeatableByDependent: true },
      },
      {
        documentTypeCode: 'military-certificate',
        requirement: 'conditional',
        condition: {
          field: 'militaryDocumentStatus',
          operator: 'in',
          value: ['applicable', 'pending-confirmation'],
        },
      },
      {
        documentTypeCode: 'vaccination-card',
        requirement: 'conditional',
        condition: { field: 'isDriver', operator: 'equals', value: true },
      },
      {
        documentTypeCode: 'passenger-transport-course',
        requirement: 'conditional',
        condition: { field: 'isDriver', operator: 'equals', value: true },
      },
      {
        documentTypeCode: 'driver-license-record',
        requirement: 'conditional',
        condition: { field: 'isDriver', operator: 'equals', value: true },
      },
      {
        documentTypeCode: 'municipal-debt-clearance',
        requirement: 'conditional',
        condition: { field: 'isDriver', operator: 'equals', value: true },
      },
    ],
  },
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
        configOverrides: { repeatableByDependent: true },
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
      {
        documentTypeCode: 'photo-3x4',
        configOverrides: { minFiles: 1, maxFiles: 1 },
      },
      ...commonItems.slice(1, 5),
      {
        documentTypeCode: 'child-identification',
        requirement: 'conditional',
        condition: { field: 'hasChildren', operator: 'equals', value: true },
        configOverrides: { repeatableByDependent: true },
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
