const METHOD_LABELS: Readonly<Record<string, string>> = {
  GET: 'Consultar',
  POST: 'Criar ou enviar',
  PUT: 'Substituir',
  PATCH: 'Atualizar',
  DELETE: 'Excluir',
};

const ACTIONS: readonly [RegExp, string][] = [
  [/^POST \/auth\/login$/, 'Entrar na plataforma'],
  [/^POST \/auth\/refresh$/, 'Renovar sessão'],
  [/^POST \/auth\/logout$/, 'Sair da plataforma'],
  [/^GET \/users$/, 'Consultar usuários'],
  [/^POST \/users$/, 'Cadastrar usuário'],
  [/^DELETE \/users\/:id$/, 'Excluir usuário'],
  [/^(GET|PATCH) \/users\/:id$/, 'Consultar ou atualizar usuário'],
  [/password-reset/, 'Solicitar recuperação de senha'],
  [/submissions\/complete$/, 'Enviar documento para análise'],
  [/submissions$/, 'Enviar arquivo documental'],
  [/files\/:fileId\/content$/, 'Visualizar arquivo documental'],
  [/files\.zip$/, 'Baixar documentos do funcionário'],
  [/export\.xlsx$/, 'Baixar dados documentais'],
  [
    /^GET \/document-management\/requests$/,
    'Consultar solicitações documentais',
  ],
  [/^POST \/document-management\/requests/, 'Criar solicitação documental'],
  [
    /^GET \/document-management\/requests\/:requestId$/,
    'Revisar solicitação documental',
  ],
  [/reviews$/, 'Registrar revisão documental'],
  [/^GET \/whatsapp\/conversations/, 'Consultar conversas'],
  [/messages/, 'Consultar ou enviar mensagem'],
  [/takeover/, 'Assumir atendimento'],
  [/return-to-bot/, 'Devolver atendimento ao bot'],
  [/close/, 'Encerrar atendimento'],
  [/quote-proposals/, 'Consultar ou atualizar orçamento'],
  [/notifications/, 'Consultar notificações'],
  [/profile/, 'Consultar ou atualizar perfil'],
  [/support/, 'Enviar solicitação de suporte'],
];

export function humanizeApiAction(method: string, route: string): string {
  const signature = `${method.toUpperCase()} ${route}`;
  return (
    ACTIONS.find(([pattern]) => pattern.test(signature))?.[1] ??
    `${METHOD_LABELS[method.toUpperCase()] ?? 'Acessar'} recurso da plataforma`
  );
}
