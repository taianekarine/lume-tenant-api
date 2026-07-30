# Encerramento e portabilidade

Os dados operacionais pertencem ao cliente e estão no PostgreSQL da instalação.

Procedimento recomendado:

1. interromper novas integrações;
2. concluir ou registrar eventos pendentes da outbox;
3. gerar backup consistente e criptografado;
4. exportar usuários, departamentos, permissões diretas, auditoria e dados de negócio;
5. não transferir refresh tokens ou sessões ativas;
6. revogar credenciais do edge;
7. entregar documentação de schema e versão da aplicação;
8. validar a restauração com o responsável autorizado;
9. remover acessos de suporte da fornecedora.

Prazos, formato da exportação, retenção e responsabilidade por backups devem
estar definidos contratualmente.
