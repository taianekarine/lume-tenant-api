UPDATE "document_types"
SET
  "extraction_schema" = CASE "code"
    WHEN 'child-birth-certificate' THEN '{"fields":[{"key":"childName","label":"Nome da criança","multiple":true},{"key":"birthDate","label":"Data de nascimento","type":"date","multiple":true},{"key":"parentage","label":"Filiação","multiple":true},{"key":"registration","label":"Matrícula da certidão","multiple":true},{"key":"registryOffice","label":"Cartório","multiple":true},{"key":"city","label":"Município","multiple":true},{"key":"state","label":"UF","multiple":true}]}'::jsonb
    WHEN 'child-vaccination-card' THEN '{"fields":[{"key":"fullName","label":"Nome completo","multiple":true},{"key":"cpf","label":"CPF","multiple":true},{"key":"birthDate","label":"Data de nascimento","type":"date","multiple":true},{"key":"issuer","label":"Unidade emissora","multiple":true},{"key":"issuedAt","label":"Data de emissão","type":"date","multiple":true},{"key":"referencePeriod","label":"Período de referência","multiple":true},{"key":"requirementInformation","label":"Informações para conferência","multiple":true}]}'::jsonb
    WHEN 'child-school-statement' THEN '{"fields":[{"key":"fullName","label":"Nome completo","multiple":true},{"key":"cpf","label":"CPF","multiple":true},{"key":"birthDate","label":"Data de nascimento","type":"date","multiple":true},{"key":"institution","label":"Instituição","multiple":true},{"key":"issuedAt","label":"Data de emissão","type":"date","multiple":true},{"key":"referencePeriod","label":"Período de referência","multiple":true},{"key":"requirementInformation","label":"Informações para conferência","multiple":true}]}'::jsonb
    WHEN 'child-identification' THEN '{"fields":[{"key":"name","label":"Nome","multiple":true},{"key":"cpf","label":"CPF","multiple":true},{"key":"rg","label":"RG","multiple":true},{"key":"birthDate","label":"Data de nascimento","type":"date","multiple":true},{"key":"relationship","label":"Vínculo com o funcionário","multiple":true},{"key":"validUntil","label":"Validade","type":"date","multiple":true}]}'::jsonb
    ELSE "extraction_schema"
  END,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "code" IN (
  'child-birth-certificate',
  'child-vaccination-card',
  'child-school-statement',
  'child-identification'
);

UPDATE "document_request_items" AS item
SET
  "config_snapshot" = jsonb_set(
    item."config_snapshot",
    '{extractionSchema}',
    document_type."extraction_schema",
    true
  ),
  "updated_at" = CURRENT_TIMESTAMP
FROM "document_types" AS document_type
WHERE item."document_type_id" = document_type."id"
  AND item."company_id" = document_type."company_id"
  AND document_type."code" IN (
    'child-birth-certificate',
    'child-vaccination-card',
    'child-school-statement',
    'child-identification'
  );
