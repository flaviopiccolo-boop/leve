# Leve Editor

Base de um editor desktop para Windows, com navegação à esquerda, código no centro e terminais embaixo. “Leve” é um nome provisório; ainda não há medições que estabeleçam seu consumo em comparação com outros editores.

## Experimentar a interface

Requer Node.js 22.12+ ou 24 e npm.

```powershell
npm install
npm run dev
```

Abra http://127.0.0.1:1420. A prévia web usa uma pasta de demonstração em memória. É possível editar, salvar na sessão, buscar nomes de arquivos, arrastar painéis e redimensionar áreas. Ela não acessa pastas reais nem executa comandos. Recarregar a página descarta o conteúdo da demonstração e mantém a disposição dos painéis.

## Rodar como aplicativo Windows

Além do Node.js, instale os [pré-requisitos oficiais do Tauri](https://v2.tauri.app/start/prerequisites/):

- Rust estável com toolchain MSVC (`rustc` e `cargo` no PATH).
- Microsoft C++ Build Tools com a carga de trabalho de desenvolvimento desktop C++ e Windows SDK.
- Microsoft Edge WebView2 Runtime.

```powershell
npm run desktop
```

No aplicativo, use **Abrir pasta** para selecionar um projeto real. A árvore carrega subpastas conforme são abertas. Abra um arquivo e use **Ctrl+S** para salvar. No painel inferior, **Iniciar PowerShell** cria uma sessão na pasta selecionada. O botão **+** cria outra aba; cada sessão inicia somente quando solicitada.

O terminal usa xterm.js na interface e portable-pty/ConPTY no backend. Esta primeira implementação inicia `powershell.exe` sem perfil, configura entrada/saída em UTF-8 e mantém a sessão interativa aberta. A interface responde às consultas de posição do cursor emitidas durante a inicialização. Fechar a aba, restaurar o layout, trocar de projeto ou sair do aplicativo encerra as sessões correspondentes. Processos iniciados pelo usuário que se desliguem da sessão podem continuar rodando.

O arraste nativo de arquivos do Windows está desativado na WebView para permitir o arraste HTML dos painéis. A abertura de projetos usa o seletor de pastas.

## O que está implementado

- Interface React + TypeScript com Tauri 2 / Rust.
- Painéis encaixáveis com FlexLayout (MIT), divisórias ajustáveis, agrupamento e divisão por arraste.
- Persistência do layout no armazenamento local e restauração do padrão.
- Árvore de arquivos, atualização manual e busca por nome/caminho (índice limitado a 5.000 arquivos e 15 níveis; ignora pastas comuns de dependências/build).
- CodeMirror 6 com histórico de edição, busca dentro do arquivo e linguagens carregadas sob demanda.
- Abas de arquivos, indicador de alterações, confirmação ao descartar e proteção ao fechar a janela.
- Backend de leitura e salvamento de arquivos existentes dentro da pasta selecionada.
- Verificação de conflito com alterações externas antes de salvar; escrita em arquivo temporário no mesmo diretório antes de substituir o original.
- Backend de PowerShell com entrada, saída em bytes, redimensionamento e encerramento de sessões.

## Limites desta primeira versão

- O frontend e o backend têm testes automatizados. Os testes Rust incluem uma sessão real de PowerShell/ConPTY com saída em UTF-8 e a execução de um arquivo batch em uma pasta com espaços e acentos. O fluxo completo da interface desktop ainda precisa de validação manual.
- Arquivos de texto UTF-8 de até 4 MB. A edição pode normalizar quebras de linha para LF. Arquivos binários são recusados.
- Sem criação/renomeação/exclusão de arquivos, Git, LSP, depuração, autocomplete de projeto, extensões ou atualização automática.
- A busca lateral encontra nomes/caminhos; busca de conteúdo usa Ctrl+F no arquivo aberto.
- Sem monitoramento automático de alterações externas. Atualize a árvore pelo botão de atualização. Um conflito no salvamento exige copiar suas alterações e reabrir o arquivo.
- Layout salvo, mas arquivos abertos e conteúdo não salvo não são recuperados após reiniciar ou uma falha.
- A checagem de conflito não constitui bloqueio transacional contra outros programas escrevendo no mesmo instante.
- Pastas reais e terminal estão disponíveis apenas no aplicativo desktop. No máximo 16 sessões simultâneas; esta base ainda não oferece reconexão/reinício automático após o shell sair.

## Validar

```powershell
npm run build
npm test
```

Os testes usam o Microsoft Edge instalado e verificam o layout, edição/salvamento, busca, proteção de alterações e persistência após arraste. Capturas ficam em `artifacts/`.

Com o Rust configurado:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
npm run desktop
```

Confira na versão nativa: abrir uma pasta real, editar/salvar e reabrir um arquivo, recusar sobrescrita após mudança externa, fechar uma aba com alterações, executar comandos com acentos, redimensionar o terminal, interromper um comando com Ctrl+C e encerrar sessões ao fechar abas/janela.

Para gerar um executável de desenvolvimento com a interface incluída, sem instalador e sem servidor web:

```powershell
npm run desktop:build:dev
```

O resultado fica em `src-tauri/target/debug/leve-editor.exe`. Essa compilação não é otimizada e não serve para medir o consumo ou desempenho final. Após instalar Rust, abra um novo terminal para que o PATH inclua Cargo.

## Gerar instalador

```powershell
npm run desktop:build
```

A configuração aponta para um instalador NSIS. A geração e o funcionamento desse instalador ainda precisam de validação nativa. Distribuição portátil, assinatura e atualização ficam para uma próxima etapa.

## Organização

- `src/App.tsx`: estrutura do aplicativo, painéis, navegação e estado dos arquivos.
- `src/Editor.tsx`: CodeMirror e carregamento das linguagens.
- `src/Terminal.tsx`: interface do terminal e comunicação com Rust.
- `src/workspace.ts`: acesso ao workspace e demonstração web.
- `src-tauri/src/main.rs`: operações locais, salvamento e sessões PTY.
- `tests/editor.spec.ts`: testes de integração da interface.

As próximas decisões de produto são a linguagem prioritária para LSP, suporte a Git e comportamento de recuperação da sessão. Elas podem ser definidas usando esta base.
