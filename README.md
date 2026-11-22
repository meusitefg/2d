# Minha Central

Dashboard responsiva em preto e branco para organizar contas Gmail e Outlook. O botão **Copiar login** coloca o e-mail na primeira linha e a senha na segunda. Ao excluir um tópico, os logins passam para **Sem tópico**.

## Conectar o banco gratuito

1. Crie um projeto no [Supabase](https://supabase.com/dashboard) no plano Free. Se for usar o Lovable, conecte esse mesmo projeto pela integração Supabase do Lovable.
2. Em **Authentication → Sign In / Providers → Email**, desative novos cadastros. Em **Authentication → Users**, crie e confirme manualmente o usuário `admsupremo1@gmail.com` com a senha de acesso escolhida. A senha é definida no painel de autenticação do Supabase.
3. Copie o UUID desse usuário. Abra `schema.sql`, substitua as quatro ocorrências de `00000000-0000-0000-0000-000000000000` pelo UUID e execute o SQL uma vez no **SQL Editor**.
4. Em `config.js`, preencha `url` com a URL do projeto e `publishableKey` com a chave **Publishable**. A chave legada `anon` também funciona. Mantenha a chave `service_role` e as chaves secretas fora do site.
5. Publique apenas `index.html`, `app.js` e `config.js` juntos em um host estático com HTTPS. Para testar localmente, execute `python3 -m http.server 8000` na pasta e abra `http://localhost:8000`.

## Dados e acesso

O cadastro público fica desativado. As políticas RLS autorizam somente o UUID definido no SQL a ler e modificar os dados. O navegador usa a senha de entrada para derivar a chave que cifra e decifra os e-mails e as senhas armazenados. A sessão e a chave de decifragem ficam no armazenamento temporário da aba, permitindo atualizar a página sem sair. Clique em **Sair** para limpar a sessão. Use o seletor ao lado do e-mail para marcar **ON**, **OFF** ou **RISCO** e **Mostrar senha** para revelar a senha no cartão. A atualização usa o esquema existente.

Uma troca de senha de entrada no Supabase muda a chave que o site deriva. Antes de trocar a senha de entrada, certifique-se de ter uma cópia dos logins para recadastrá-los com a nova senha. A dashboard anterior salvava dados apenas no navegador. Caso você já tenha registros, recadastre-os na nova dashboard e mantenha os dados anteriores até confirmar a transferência.

## Aulas

O botão **Aulas**, logo abaixo de **Todas as contas**, abre o painel de módulos e vídeos do YouTube. Os módulos e as aulas ficam no armazenamento do navegador usado para cadastrá-los. Para migrar da versão anterior da Minha Central, atualize apenas `index.html` e `app.js` e mantenha seu `config.js`. A seção Aulas usa os arquivos atualizados sem exigir alterações no banco de contas.

## Face Marketplace

Cole um link do Facebook e clique em **Adicionar link**. O anúncio abre em outra aba. Use o seletor para marcar **Já chamei**, **Vendido** ou **Em Aguardo**. Você pode editar ou excluir cada link. A lista fica salva no navegador e não exige alteração no Supabase.

## Seções abaixo de Face Marketplace

As 19 seções novas têm cadastro, edição e exclusão. Nas categorias com WhatsApp, informe o número completo com código do país e DDD para gerar um link clicável `wa.me`. A Calculadora Pro registra vendas por data e origem, exibe o total vendido e calcula o lucro descontando os custos informados. Os registros dessas seções ficam no navegador. Atualize `index.html` e `app.js` e mantenha o `config.js` usado no GitHub Pages.

## Busca e classificação dos links

Use **Buscar seção** no topo do menu para filtrar pelo nome. No Marketplace, selecione Veículo, Eletrônico ou Terreno. Registros antigos continuam disponíveis para edição. Fornecedores Gringos, Fornecedores Br e Painéis SMM têm campo de descrição. SMM e Hosting têm classificação por cor. Disparo Wpp E Dev permite selecionar API oficial, Ferramenta ou Automação. Cloakers e Fornecedor Do 7 ficam abaixo de Gateways.

## Seções abaixo de Fornecedor Do 7

Da seção **Sites De Filmes** até **Depix On**, as novas listas permitem salvar, abrir, editar, classificar e excluir links. **Minas** aceita links do Facebook e tem os estados **Chamar** e **Já chamei**. Os registros ficam salvos no navegador.

## Números Aquecidos e Verificar Bms

Registre o número do WhatsApp, o Gmail de recuperação e a data de início. O painel calcula os dias corridos e permite marcar **Pronto pra uso**, **Maturando** ou **Ban**. Em **Verificar Bms**, salve e organize anotações com títulos opcionais. Links com `https://` ou `http://` colados no texto ficam clicáveis. Os registros das duas seções ficam no navegador.

## Salvar Contatos e listas de sites

**Salvar Contatos** guarda nome e número, com status **Salvar** ou **Já salvo**. Números brasileiros com DDD recebem +55 automaticamente. Para números internacionais, informe o código do país com +. **Vsl**, **Hospedagem Sites** e **Fornecedores roupa gringos** permitem cadastrar, editar e excluir links clicáveis. Os fornecedores de roupa também podem ser marcados como **Barato** ou **Caro**. Os dados ficam no navegador.

## Disparo Pro

Abaixo de **Fornecedores Gringos**, cole um número por linha. Números brasileiros com DDD recebem +55 automaticamente e viram links `wa.me`. Cadastre cada mensagem de texto separadamente. Cada botão copia um item da própria fila e avança somente após a cópia. As filas e o progresso ficam no navegador.

## Chaves Pix

Abaixo de **Fornecedores roupa gringos**, cadastre a chave Pix, o nome do titular e o tipo: Aleatória, CPF, CNPJ ou Número. Use **ON** (verde) e **OFF** (vermelho) para indicar a situação. As chaves podem ser editadas ou excluídas e ficam salvas neste navegador.

## Criador Instagram e Login Testes Insta

Defina sua senha fixa na primeira vez que gerar um lote. O painel armazena a senha cifrada no navegador e usa a mesma senha nos lotes seguintes. Gere 50 nomes de usuário, clique para copiar o usuário e clique novamente para copiar a senha. A segunda cópia move o item para **Login Testes Insta** com status **Em análise**, que pode ser alterado para **Ban** ou **ON**. O gerador cria sugestões e registros locais, sem consultar a disponibilidade de nomes na plataforma.

## Cópia de Pix e novos catálogos

**Chaves Pix** aceita o tipo **E-mail**. O botão **Copiar chave** copia o valor salvo. As sete categorias abaixo de **LOGIN TESTES INSTA** usam o mesmo formulário de Painéis SMM, com site ou WhatsApp, descrição, edição, exclusão e classificação **Barato** ou **Caro**.

## Documentos Top

Abaixo de **Forum Russos**, informe o titular e selecione um arquivo PNG, JPG, JPEG ou PDF. A lista permite visualizar e baixar o documento. O conteúdo e os dados do arquivo são cifrados e guardados no IndexedDB do navegador em que foram adicionados. A prévia de PDF depende do suporte do navegador. Use **Baixar** para abrir o arquivo em outro leitor.

Documentos Top aceita um arquivo avulso ou anexos separados de **Selfie**, **Frente** e **Verso** no mesmo cadastro. Preencha os campos de arquivo de que precisar. Cada anexo pode ser visualizado e baixado separadamente. **Excluir conjunto** remove todos os anexos daquele cadastro após confirmação. Os arquivos cadastrados anteriormente também podem ser visualizados, baixados e excluídos.

## Canais Acompanhar

Em **Canais Acompanhar**, adicione o link de um canal do YouTube e descreva o assunto. Escolha um tópico existente ou escreva um novo. Use o filtro por tópico para encontrar os canais salvos. Os links abrem em outra aba, e cada item pode ser editado ou excluído. Os registros ficam no navegador.

## Calendário Pro

Abaixo de **Canais Acompanhar**, cadastre obrigações com data e, se quiser, valor em reais e observações. Datas com obrigações ativas ficam verdes. Navegue pelos meses ou clique em **Hoje**. O painel mostra avisos da data de vencimento até três dias antes enquanto a dashboard está aberta e autenticada. **Desmarcar** suspende o aviso e a marcação verde. **Reativar** restaura ambos. Os registros ficam no navegador.
