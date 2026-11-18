# Automação para agentes

## Objetivo

Permitir que um agente de IA edite vídeos do zero usando o próprio Retalho, com o mesmo núcleo de edição que a interface usa. O agente não clica em nada: ele envia comandos e confere o resultado.

O andamento de cada fase está em [ROADMAP-AGENTE.md](ROADMAP-AGENTE.md).

## Decisões

1. **O agente usa o Retalho num Chrome headless, com o próprio editor carregado, e entrega um arquivo `.retalho`.** Não existe versão separada de edição em Node. Motivo: vídeo, áudio, GPU e exportação dependem de APIs do navegador. Uma segunda implementação divergiria do que a interface mostra.
2. **A ponte `window.retalho` só existe quando `import.meta.env.DEV` é verdadeiro ou quando a variável de build `VITE_RETALHO_AUTOMATION` vale `"1"`.** Motivo: uma versão de produção comum não deve expor controle do editor à página. O `window.__retalho` usado pelo e2e continua como está.
3. **O script de automação não depende de caminhos fixos.** O Chrome e o ffmpeg são detectados ou vêm de `RETALHO_CHROME` e `RETALHO_FFMPEG`. Motivo: o script roda nesta máquina hoje, mas precisa funcionar em outra sem edição.

### Decisões confirmadas do contrato

- **Tempos:** chegam em segundos e viram microssegundos inteiros. `dividir` ainda arredonda ao quadro mais próximo.
- **`borda`:** usa `left`, `top`, `right` e `bottom`, como o modelo.
- **`cortarPausas`:** segue a mesma regra na interface e nos comandos. Os dois cortam a partir de `analise.pausas`, e a interface mede o clipe antes, se ainda não houver análise.
- **`substituirTexto` e `definirTexto`:** recusam textos em faixa bloqueada, mesmo que `replaceInTexts` e `updateMaterial` não façam essa checagem.
- **Repetir é seguro:** `definirKeyframe` e `marcar` nunca removem. Remover é sempre um comando próprio.

## Arquitetura

| Camada | Arquivo | Papel | Situação |
|---|---|---|---|
| Comandos puros | `src/core/commands.ts` | Recebem um projeto e argumentos nomeados e devolvem um resultado. Não tocam em navegador, interface ou armazenamento | Implementado |
| Planos | `executarPlano` em `src/core/commands.ts` | Vários comandos de uma vez, ligados por nome, aplicados juntos ou nada | Implementado |
| Ponte no navegador | `src/ui/automation.ts` → `window.retalho` | Planos, consultas, quadro, folha de contato, volume e exportação. Só existe com a flag | Implementado |
| CLI | `tools/retalho.mjs` (`npm run agente`) | Liga o Vite e um Chrome sem janela, usa a ponte e fecha tudo | Implementado |

O guia prático, com o formato do plano e um exemplo completo, está em [AGENTE.md](AGENTE.md).

## Desfazer e atomicidade

- **Uma etapa de desfazer por plano.** Um plano inteiro é aplicado com uma única chamada a `edit()`.
- **Atomicidade.** Um plano que falha não altera o projeto, porque os passos rodam sobre um rascunho.

## Comandos

Um comando roda com `executarComando(projeto, comando, args)`, de `src/core/commands.ts`. O projeto recebido nunca é alterado. A descrição e os limites de cada argumento estão em `src/core/commandSchema.ts`.

**Unidades**
- Tempos são em **segundos**, na timeline, salvo onde o comando diz "tempo da fonte". Internamente viram microssegundos.
- Valores de opção de formato, como `borda`, `suavizacao` e os campos de máscara, usam os nomes de `src/core/model.ts`.

### Resultado

```ts
type Resultado =
  | { ok: true; projeto: Project; alterado: boolean; afetados: string[]; avisos: string[] }
  | { ok: false; codigo: CodigoErro; mensagem: string; detalhes?: unknown };
```

- `afetados` lista ids de clipes, faixas, materiais e marcadores que mudaram, com os **criados primeiro**.
- `avisos` registra ajustes e diz o valor efetivo.
- `alterado: false` significa que o comando é válido, mas não mudou nada. Não é erro.

### Edição

`?` marca argumento opcional.

| Comando | Argumentos | Observações |
|---|---|---|
| `adicionarClipe` | `materialId`, `inicio`, `faixaId?` | Avisa se foi para outro espaço livre |
| `moverClipe` | `clipeId`, `inicio`, `faixaId?`, `apenasClipe?` | Move o grupo inteiro, mantendo as distâncias; veja abaixo |
| `aparar` | `clipeId`, `lado` (`inicio` ou `fim`), `tempo` | Avisa se a fonte ou o vizinho limitou |
| `dividir` | `clipeId`, `tempo` | Alinha ao quadro mais próximo, com aviso se o tempo mudou. A parte nova é o primeiro id de `afetados` |
| `excluir` | `clipeId`, `fecharEspaco?` | |
| `duplicar` | `clipeId` | |
| `definirVelocidade` | `clipeId`, `velocidade` (0,1 a 10) | Só vídeo e áudio |
| `congelarQuadro` | `clipeId`, `tempo`, `duracao?` | Só vídeo. Sem `duracao`, usa 3 s |
| `definirPropriedade` | `clipeId`, `propriedade`, `valor`, `tempo?` | `tempo` é obrigatório se a propriedade é animada, e ignorado com aviso se não é |
| `definirKeyframe` | `clipeId`, `propriedade`, `tempo`, `valor?` | Cria ou atualiza, nunca remove. Sem `valor`, usa o valor atual naquele tempo. Se já existia, avisa |
| `removerKeyframe` | `clipeId`, `propriedade`, `tempo` | Sem keyframe no tempo, devolve `ARGUMENTO_INVALIDO` com `detalhes.tempos`, em segundos |
| `definirSuavizacao` | `clipeId`, `suavizacao` (ou `null`), `tempo?` | Valores: `in`, `out`, `inOut`, `hold`, `back`, `elastic`, `bounce` |
| `definirRecorte` | `clipeId`, `borda` (`left`, `top`, `right`, `bottom`), `valor` (0 a 1) | Avisa se a borda oposta limitou |
| `adicionarTexto` | `texto`, `inicio`, `duracao`, `faixaId?` | |
| `definirTexto` | `materialId` ou `clipeId`, `texto` | Exatamente um dos dois ids |
| `substituirTexto` | `de`, `para` | Vale para todos os textos e diferencia maiúsculas |
| `definirVolume` | `clipeId`, `volume` (0 a 4) | Só vídeo e áudio |
| `cortarTrechos` | `clipeId`, `trechos`: `[{ inicio, fim }]` | **Tempo da fonte.** Avisa se limitou ao clipe |
| `marcar` | `tempo`, `rotulo?` | Se já existe marcador nesse quadro, devolve `alterado: false` com aviso. Sem `rotulo`, numera |
| `removerMarcador` | `marcadorId` | O id aparece em `inspecionar`. Se não existir, devolve `ARGUMENTO_INVALIDO` |
| `definirMascara` | `clipeId`, `mascara` (ou `null`) | Objeto completo no formato de `Mask` |
| `definirChroma` | `clipeId`, `chroma` (ou `null`) | Objeto completo no formato de `Chroma` |
| `definirEfeito` | `clipeId`, `efeito`, `valor` (0 a 1, ou `null`) | `null` remove o efeito e seus keyframes. Efeito animado usa `definirPropriedade` |
| `definirHsl` | `clipeId`, `cor`, `ajuste` (ou `null`) | `ajuste`: `hue`, `saturation`, `lightness`, de -100 a 100 |
| `definirCurvas` | `clipeId`, `canal`, `pontos` (ou `null`) | `pontos`: lista de `[x, y]`, de 0 a 1, com ao menos 2 |
| `definirLut` | `clipeId`, `lutId` (ou `null`), `forca?` | A LUT precisa já estar no projeto |
| `cortarPausas` | `clipeId`, `minimo?` | Usa `analise.pausas`, com mínimo padrão de 0,5 s. Sem análise, devolve `ARGUMENTO_INVALIDO`, indicando `analisarPausas` |
| `cortarHesitacoes` | `clipeId` | Só usa `words` da faixa do clipe |
| `criarLegendas` | `clipeId` | Só usa `words` da faixa do clipe |

### Criação (para montar vídeos do zero)

| Comando | Argumentos | Observações |
|---|---|---|
| `adicionarClipe` | também `duracao?` e `inicioFonte?` | `inicioFonte` é tempo da fonte. Sem fonte com tempo (imagem), `inicioFonte` é ignorado com aviso. Avisa se a duração foi limitada pelo fim do material |
| `definirProjeto` | `nome?`, `largura?`, `altura?`, `fps?`, `fundo?` | `fundo` é uma cor; `null` volta ao preto. `afetados` traz o id do projeto |
| `criarFaixa` | `tipo` (`video`, `text`, `audio`), `nome?`, `posicao?` | Sem `posicao`, entra por último, ou seja, desenha por cima das outras do mesmo tipo. Texto sempre desenha acima de vídeo |
| `adicionarForma` | `forma`, `inicio`, `duracao`, `faixaId?` | Formas vão em faixa de texto |
| `estilizar` | `clipeId` ou `materialId`, `estilo` | Campos de `TextMaterial` ou `ShapeMaterial`. Em texto: `backgroundPadding` (0 a 3, em tamanhos de fonte) e `backgroundRadius` (0 a 1, 1 é pílula). `null` remove `shadow` e `spoken` |
| `definirAnimacao` | `clipeId`, `entrada?`, `saida?`, `loop?` | Cada um é `{ tipo, duracao }` ou `null`. Tipos em `src/core/animation.ts` |
| `definirMoldura` | `clipeId`, `moldura` (ou `null`) | Formato de `ClipFrame`. Só vídeo e imagem |
| `definirEnquadramento` | `clipeId`, `enquadramento` (`contain` ou `cover`) | `cover` preenche a tela e corta o que sobra. Para escolher a parte que aparece, mova com `x` e `y` |
| `definirFades` | `clipeId`, `entrada?`, `saida?` | Segundos, limitados à duração do clipe. Só vídeo e áudio |
| `definirEfeitosDeAudio` | `clipeId`, `efeitos` (ou `null`) | Formato de `AudioEffects` |
| `definirTransformacao` | `clipeId`, `x?`, `y?`, `escala?`, `rotacao?`, `opacidade?` | Para propriedades sem keyframes. Com keyframes, use `definirKeyframe` |
| `adicionarLegendas` | `palavras`, `faixaId?`, `nome?`, `maxPalavras?`, `maxLetras?`, `maiusculas?`, `sobra?`, `y?`, `estilo?`, `destaque?`, `entrada?` | `palavras`: `[{ texto, inicio, fim, quebra? }]` em tempo da timeline. Quebra na pontuação, em pausas de 0,7 s e onde `quebra` é verdadeiro. `destaque`: `{ cor, escala?, caixa?, modo? }` |

### Planos

`executarPlano(projeto, passos, { falharAoPrimeiroErro })` roda uma lista de `{ comando, args, como? }`.

- O plano inteiro é conferido antes: comando, argumentos, nomes repetidos e referências a passos que ainda não vieram. Um erro nessa conferência não executa nada.
- `como` dá nome ao que o passo criou: a faixa, em `criarFaixa` e `adicionarLegendas`; o clipe, nos outros.
- Em argumentos de id, `"$nome"` vira o id do passo que tem esse `como`, e `"@arquivo.mp4"` vira o material importado com esse nome. Textos não são tocados, então `"$47"` num texto continua `"$47"`.
- Com `falharAoPrimeiroErro` (padrão), o primeiro erro devolve o projeto de entrada. Sem ele, o passo é pulado e o relatório mostra qual foi.

**`moverClipe` com grupo**
- Sem grupo, ou com `apenasClipe: true`, vai para o espaço livre mais próximo e avisa o início efetivo. Sem `faixaId`, fica na faixa atual.
- Com grupo, todos os membros andam o mesmo tempo, cada um na sua faixa. Se algum colidir, devolve `SOBREPOSICAO` com `detalhes.conflitos` e nada muda.
- Mudar um grupo de faixa não existe: `faixaId` diferente da faixa atual devolve `ARGUMENTO_INVALIDO`, e a saída é `apenasClipe: true`.
- Se o grupo passaria do começo da timeline, ele para em 0 e avisa.

**Propriedades de `definirPropriedade`, `definirKeyframe` e `removerKeyframe`**
- Posição: `x`, `y`, `rotation`, `scale` (maior que 0) e `opacity` (0 a 1). Valem para clipes visuais.
- Cor, de -100 a 100: `brightness`, `contrast`, `saturation`, `exposure`, `temperature`, `tint`, `hue`, `highlights`, `shadows`, `vignette`.
- Cor, de 0 a 100: `sharpen`, `grain`, `fade`.
- Efeitos, de 0 a 1: `blur`, `glow`, `glitch`, `pixelate`, `shake`, `retro`.

Cor e efeitos valem só para vídeo, imagem e camada de ajuste, como no painel.

### Análise do material

Os comandos de análise **não medem nada**: recebem o resultado já calculado, validam e gravam no clipe. A medição fica para a ponte da Fase 3.

| Comando | Argumentos | Grava em |
|---|---|---|
| `analisarCenas` | `clipeId`, `cenas`: lista de tempos em ordem crescente | `analise.cenas` |
| `analisarPausas` | `clipeId`, `pausas`: `[{ inicio, fim }]`, sem sobreposição | `analise.pausas`, em ordem |
| `analisarBatidas` | `clipeId`, `batidas`: lista de tempos em ordem crescente | `analise.batidas` e `beats` |
| `analisarLoudness` | `clipeId`, `loudness`: `{ integrado, pico }` | `analise.loudness`. `integrado` de -70 a 0 LUFS, `pico` de -120 a 0 dBFS |
| `transcrever` | `clipeId`, `palavras`: `[{ text, start, end }]` | `words`, com `end` depois de `start` |

- Os tempos chegam em **segundos, em tempo da fonte**, e são gravados em microssegundos. Precisam estar dentro de `source` do clipe, ou o comando devolve `FORA_DA_FONTE`.
- Repetir o mesmo valor devolve `alterado: false` e mantém `geradoEm`.
- Só valem para vídeo e áudio. Clipe sem fonte, ou congelado, devolve `PROPRIEDADE_NAO_SUPORTADA`.

**O campo `analise`** é opcional, fica no clipe e é definido em `src/core/model.ts`:

```ts
analise?: {
  versao: 1;
  geradoEm: string;                     // ISO 8601
  cenas?: Us[];
  pausas?: { inicio: Us; fim: Us }[];
  batidas?: Us[];
  loudness?: { integrado: number; pico: number };
};
```

- Tudo fica em tempo da fonte, como `words` e `beats`, então sobrevive a cortes e mudanças de velocidade. Os pedaços de um clipe cortado herdam a análise inteira, e cada comando usa só o que cai dentro do pedaço.
- `words` e `beats` continuam onde estavam. Projetos antigos, sem `analise`, seguem válidos.
- `analise.pausas` guarda o **silêncio medido inteiro**. A margem de 0,08 s em volta das palavras só entra na hora de cortar, e silêncio encostado na ponta do clipe sai inteiro.
- `inspecionar` mostra a análise de cada clipe em segundos, em tempo da fonte.

### Consultas

| Função | Devolve |
|---|---|
| `inspecionar(projeto)` | Nome, fps, canvas, duração, faixas com clipes, marcadores, materiais e LUTs. Em `animadas`, os tempos de keyframe estão na timeline. Não inclui as mídias |
| `validar(projeto)` | Lista de problemas: `{ codigo, gravidade, mensagem, clipeId?, faixaId?, tempo? }` |

Códigos de `validar`: `DURACAO_ZERO`, `SOBREPOSICAO_NA_FAIXA` e `MATERIAL_OFFLINE` (erros), `TEXTO_VAZIO` e `FAIXA_BLOQUEADA_COM_CLIPES` (avisos).

### Códigos de erro

| Código | Quando |
|---|---|
| `COMANDO_DESCONHECIDO` | O nome do comando não existe |
| `ARGUMENTO_INVALIDO` | Argumento faltando, sobrando, com tipo errado ou fora do limite. Também faixa ou marcador inexistente, tempo sem keyframe ou fora do clipe e propriedade animada sem `tempo`. A mensagem sempre diz o argumento, o valor recebido e o que é aceito: `tempo: recebido -1, esperado número maior ou igual a 0` |
| `CLIPE_NAO_ENCONTRADO` | O `clipeId` não existe |
| `MATERIAL_NAO_ENCONTRADO` | O material ou a LUT não existe |
| `FAIXA_BLOQUEADA` | O clipe, a faixa de destino ou um texto afetado está em faixa bloqueada |
| `SOBREPOSICAO` | O grupo de `moverClipe` colidiria com outros clipes. Os ids estão em `detalhes.conflitos`. Um clipe sozinho não devolve esse código, porque vai ao espaço livre mais próximo, com aviso |
| `CORTE_MUITO_CURTO` | O clipe ou uma das partes ficaria com menos de um quadro |
| `CORTE_FORA_DO_CLIPE` | O tempo ou trecho do corte fica fora do clipe |
| `FORA_DA_FONTE` | Um tempo de análise fica fora de `source` do clipe. Os limites estão em `detalhes` |
| `TIPO_DE_FAIXA_INCOMPATIVEL` | A faixa de destino é de outro tipo |
| `PROPRIEDADE_NAO_SUPORTADA` | O clipe não aceita aquela propriedade ou operação |

## Como o agente trabalha

O caminho curto é `npm run agente -- render plano.json`: importa, executa, valida, acerta o volume e entrega `.retalho`, folha de contato e MP4. Os passos soltos servem para ir aos poucos no mesmo projeto, que fica salvo em `.agente/perfil` entre uma chamada e outra.

| Passo | Comando |
|---|---|
| 1. Importar | `npm run agente -- importar pasta/ outro.mp4` |
| 2. Inspecionar | `npm run agente -- inspecionar` |
| 3. Simular | `npm run agente -- executar plano.json --simular` |
| 4. Executar | `npm run agente -- executar plano.json` |
| 5. Validar | `npm run agente -- validar` |
| 6. Olhar a folha de contatos | `npm run agente -- folha --de 0 --ate 10 --passo 0.5 --saida folha.jpg` |
| 7. Acertar o volume | `npm run agente -- audio --normalizar -14` |
| 8. Exportar | `npm run agente -- exportar --formato mp4 --saida video.mp4` |

### A ponte `window.retalho`

| Método | Devolve |
|---|---|
| `comandos()` | Cada comando com descrição e argumentos |
| `midias()` | Materiais importados e fontes, com nome, tipo e tamanho |
| `inspecionar()`, `validar()` | Como em `commands.ts`, sobre o projeto aberto |
| `executar(passos, { simular, falharAoPrimeiroErro })` | Relatório, nomes e duração. Aplica numa etapa só de desfazer |
| `novo(nome?)` | Começa um projeto vazio; o atual fica na lista de projetos |
| `quadro(tempo)` | PNG do quadro, como data URL |
| `folha({ de, ate, passo, colunas, largura })` | JPEG com os quadros em grade e o tempo de cada um |
| `medirAudio()` | `{ lufs, picoDb }` da mixagem inteira |
| `normalizarAudio({ alvo, picoMax })` | Escala todos os clipes com som por igual, mantendo o equilíbrio entre eles, e mede de novo |
| `exportar({ formato, qualidade, lado, fps, desfoque, tempo })` | `{ arquivo, tamanho }`. Leia com `lerArquivo(arquivo, inicio, fim)`, em base64, e libere com `liberarArquivo` |
| `esperar()`, `estado()`, `gravar()` | Espera o áudio processar, mostra tarefa e aviso, salva no navegador na hora |

## O que o agente nunca faz

- Alterar o código-fonte do editor.
- Pular a validação.
- Entregar sem olhar a folha de contatos.
