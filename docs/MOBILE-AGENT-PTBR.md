# Mobile Agent PT-BR — versão de testes

Esta versão é desenvolvida no fork `Gustavojv065/mobile-agent`, com alterações sempre por Pull Requests. Não substitua o aplicativo original antes de validar o novo APK.

## O que foi preparado

- Menus principais, barra lateral e biblioteca parcialmente traduzidos.
- Configurações principais e tela de voz em português.
- Reconhecimento Whisper local: português como preferência inicial quando suportado; preferências salvas são preservadas.
- Catálogo de conexões com destaque para GitHub, Supabase, Notion e outros serviços.
- GitHub: assistente para criar e inserir um token fine-grained, testar a conexão e atualizar credenciais.
- Credenciais do GitHub armazenadas pelo cofre de segredos já existente no aplicativo.
- CI: checagem TypeScript e testes de unidade.
- Workflow experimental `Android APK Preview PT-BR`: tenta gerar um APK ARM64 de depuração sem `EXPO_TOKEN` usando GitHub Actions.

## Testar as conexões

1. Em **Configurações → Conexões e serviços**, selecione **GitHub**.
2. Crie um token **fine-grained** no seu navegador. Prefira acesso somente aos repositórios necessários e permissões de leitura.
3. Cole o token **apenas no campo protegido do aplicativo** e toque em **Conectar e testar**.
4. Se falhar, abra **Conexões e serviços**, veja o diagnóstico e use **Atualizar acesso**. Não envie o token em prints, issues ou chats.
5. Para Notion, Supabase e serviços OAuth, siga a autorização no navegador; o resultado só é comprovado após teste real.

## Testar a geração do APK (após habilitar Actions)

1. Abra a aba **Actions** do seu fork, `https://github.com/Gustavojv065/mobile-agent/actions`.
2. Se o GitHub informar que os workflows do fork estão desativados, habilite-os usando a opção exibida.
3. No PR, aguarde um novo evento de execução do workflow `Android APK Preview PT-BR`. Se não houver execução, será preciso disparar um novo commit para gerar um evento `pull_request`.
4. Após um build bem-sucedido, abra o workflow e baixe o artefato `mobile-agent-ptbr-arm64-preview`.
5. O artefato é um APK de **teste, não uma versão de produção assinada**. Ele usa o identificador `com.gustavojv065.mobileagent.preview`, separado do aplicativo original, e não aponta para o projeto EAS/atualizações do desenvolvedor original.

## Limitações atuais

- Não foi confirmado build ou execução em aparelho real; não chamar o APK de pronto até obter artefato e realizar teste.
- O workflow pode exigir ajustes nativos ou de memória após a primeira compilação.
- O instalador de produção original `android.yml` ainda requer o segredo `EXPO_TOKEN`; o novo preview foi feito justamente para não depender dele.
- Tradução PT-BR ainda não cobre todas as telas, logs técnicos nem todo conteúdo retornado pelos modelos.
- Fluxos OAuth e comandos de voz precisam ser testados em dispositivo.
- Nunca publique tokens, chaves de API ou segredos no repositório.
