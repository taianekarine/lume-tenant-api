UPDATE "document_types"
SET "name" = 'Documentos pessoais do cônjuge — RG e CPF',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "code" = 'spouse-identification';
