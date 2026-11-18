# Roteiro da automação para agentes

O plano técnico está em [AUTOMACAO.md](AUTOMACAO.md). Cada fase só começa depois de liberada.

| Fase | Assunto | Status |
|---|---|---|
| 0 | Documentação | concluída |
| 1 | Comandos puros | concluída |
| 2 | Análise do material como dados | concluída |
| 3 | Ponte e CLI | concluída |
| 4 | Plano em JSON | concluída |
| 5 | Verificação para o agente | parcial: folha de contato, medição e normalização do som e o guia `docs/AGENTE.md` prontos; códigos novos de `validar` pendentes |

## Fase 0: documentação

**Status:** concluída

**Entregas**
- `docs/AUTOMACAO.md`, com objetivo, decisões, arquitetura e modo de trabalho do agente.
- Seção "Automação para agentes" no `README.md`.
- Este roteiro.

**Critérios de aceite**
- `npm test` e `npm run build` passam.

## Fase 1: comandos puros

**Status:** concluída

Ficou de fora `moverMarcador`, porque `ops.ts` não tem operação para mover marcador.

**Correção do contrato (feita antes da Fase 2):** `definirKeyframe` e `marcar` deixaram de alternar, com `removerKeyframe` e `removerMarcador` separados. `moverClipe` move o grupo, `dividir` alinha ao quadro e as mensagens de `ARGUMENTO_INVALIDO` dizem argumento, valor recebido e o que é aceito.

**Entregas**
- `src/core/commands.ts`, com os comandos de edição e as consultas `inspecionar` e `validar`.
- `src/core/commandSchema.ts`, com a descrição de cada comando e os validadores escritos à mão.
- `tests/commands.test.ts`.

**Critérios de aceite**
- Cada comando tem um teste de sucesso e um teste por código de erro que pode devolver.
- Cada comando é puro: o projeto de entrada não muda.
- Comandos que ajustam valores geram aviso com o valor efetivo.
- `inspecionar` e `validar` são determinísticos.
- `npm test`, `npm run build` e `npm run e2e` passam.
- `docs/AUTOMACAO.md` lista comandos, argumentos e códigos de erro como estão implementados.

## Fase 2: análise do material como dados

**Status:** concluída

**Entregas**
- Comandos `analisarCenas`, `analisarBatidas`, `analisarPausas`, `analisarLoudness` e `transcrever`.
- Campo `analise` no clipe: `{ versao, geradoEm, cenas?, pausas?, batidas?, loudness? }`. As palavras continuam em `words`.
- `cortarPausas` usa `analise.pausas`, e a interface segue a mesma regra.

**Critérios de aceite**
- Os comandos só validam e gravam; a medição fica para a ponte da Fase 3.
- `npm test`, `npm run build` e `npm run e2e` passam.

## Fase 3: ponte e CLI

**Status:** concluída. A ponte ficou em `src/ui/automation.ts`, porque usa o store e as ações da interface. Ela também mede e normaliza o som da mixagem. Além disso, entraram comandos de criação (projeto, faixas, formas, estilo, animação, moldura, enquadramento, fades, efeitos de áudio, transformação e legendas de palavras com tempo), o modo `cover`, a margem e o canto do fundo do texto, e o tamanho e a caixa da palavra falada.

Ficou pendente: `scripts/agente.e2e.mjs`. O teste real foi o vídeo 2 da oferta, com 207 passos, renderizado e conferido no ffmpeg. Também falta a documentação do modelo do Whisper offline (`--sem-rede`).

**Entregas**
- `src/engine/automation.ts`, que registra `window.retalho` com `{ inspecionar, validar, executar, exportar, quadro, carregar }`.
- `tools/retalho.mjs` e o script `npm run agente`, com `abrir`, `importar`, `inspecionar`, `validar`, `executar`, `quadro`, `exportar`, `salvar` e `carregar`.
- `scripts/agente.e2e.mjs`, com os fixtures de `makeFixtures` em um módulo compartilhado.
- Documentação de como baixar o modelo do Whisper uma vez, para trabalhar offline depois. Veio da Fase 2, porque depende do perfil persistente.

**Critérios de aceite**
- Sem a flag, em build de produção, `window.retalho` é `undefined`.
- A ponte não expõe `setState` nem o store inteiro.
- Saída principal em JSON no stdout e progresso no stderr.
- Códigos de saída: `0` sucesso, `1` erro do plano ou do comando, `2` erro de ambiente.
- Chrome vem de `RETALHO_CHROME` ou dos caminhos padrão; sem nenhum, sai com código 2.
- ffmpeg é opcional: sem ele, as verificações são puladas com aviso.
- Servidor e Chrome sempre são encerrados, mesmo em erro.
- Sem o modelo em cache e com `--sem-rede`, a transcrição falha com `MODELO_AUSENTE` e não tenta baixar.
- O teste importa o vídeo, roda um plano que corta e adiciona texto, exporta MP4 e confere com o ffmpeg quando disponível.

## Fase 4: plano em JSON

**Status:** concluída. Os passos também aceitam `como`, e os argumentos de id aceitam `"$nome"` e `"@arquivo"`. Testes em `tests/creative.test.ts`.

**Entregas**
- Formato de plano com `versao`, `projeto`, `falharAoPrimeiroErro` e `passos`.
- Função pura `executarPlano(projeto, passos)` em `src/core/commands.ts`.
- Relatório por passo: `{ indice, comando, ok, codigo?, mensagem?, afetados, avisos }`.

**Critérios de aceite**
- O plano inteiro é validado antes de executar, e erro de validação não executa nenhum passo.
- O resultado final entra com uma única chamada a `edit()`.
- Com `falharAoPrimeiroErro: true`, o primeiro erro para tudo e nada é aplicado.
- Com `false`, os passos que falham são pulados e aparecem no relatório.
- `--simular` não salva e devolve o mesmo relatório.
- Testes cobrem plano válido, erro no meio, comando desconhecido e `falharAoPrimeiroErro: false`.

## Fase 5: verificação para o agente

**Status:** pendente

**Entregas**
- `validar` ampliado com `AUDIO_SATURADO`, `TEXTO_FORA_DA_MOLDURA`, `SOBREPOSICAO_NA_FAIXA`, `LEGENDA_SEM_TEMPO`, `DURACAO_ZERO`, `MATERIAL_OFFLINE` e `LEGENDA_FORA_DA_FALA`.
- `folha`, que gera uma imagem com quadros em grade e o tempo em cada um.
- `loudness`, com LUFS integrado e pico do áudio exportado.
- `docs/AGENTE.md`, o guia que o agente lê antes de editar.

**Critérios de aceite**
- Cada problema tem `codigo`, `gravidade` (`erro` ou `aviso`), `clipeId` quando houver e `tempo`.
- O guia explica o ciclo completo, com exemplos de plano e os erros mais comuns.
