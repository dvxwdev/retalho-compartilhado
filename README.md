# Retalho

Editor de vídeo que roda no navegador, sem servidor: a mídia fica na sua máquina.
A arquitetura foi guiada pelo estudo do CapCut descrito em
[docs/ARQUITETURA-CAPCUT.md](docs/ARQUITETURA-CAPCUT.md), mas código, nome e
visual são próprios.

## Como rodar

Requer Node 22 e Chrome ou Edge atualizados. A exportação depende de WebCodecs.

```bash
npm install
npm run dev
```

Abra o endereço que aparecer no terminal.

## O que faz

- Importa vídeo, áudio e imagem, por botão ou arrastando para a janela.
- Timeline com várias faixas: mover, aparar, dividir, excluir e fechar o espaço, com encaixe e zoom.
- Copiar, colar, duplicar e colar atributos. Bloquear faixas e marcar pontos na régua.
- Congelar quadro por 3 segundos, extrair o áudio de um vídeo e gravar narração pelo microfone.
- Velocidade que mantém o tom, com opção de efeito de fita.
- Balanço estéreo, equalizador, compressor, reverb, redução de ruído, normalização para -14 LUFS e detecção de batidas, que servem de encaixe.
- A música abaixa sozinha sob a fala, e o vídeo pode ser cortado no ritmo da batida.
- Texto com fonte, cor, contorno, fundo com margem e cantos arredondados (até virar pílula), sombra, alinhamento, espaçamento e curvatura.
- Vídeo e imagem inteiros na tela ou preenchendo a tela, em **Posição → Enquadrar na tela**. Ao preencher, a sobra é cortada.
- Formas com gradiente, contorno e entrada desenhada, modelos animados prontos e camada de ajuste, na aba **Elementos**.
- Animação letra a letra, movimentos de câmera, curvas com mola e recorte por camada.
- Editor de legendas com busca e troca, e legendas estilo karaokê, na aba **Fala**. A palavra falada pode mudar de cor, crescer e ganhar uma caixa atrás, e as vizinhas abrem espaço para ela.
- 8 modelos de texto com aparência e animação, além de estilos próprios salvos no navegador.
- Animações de entrada, saída e loop em textos, vídeos e imagens.
- Posição, escala, rotação e opacidade, com keyframes e suavização. Arraste o clipe direto no preview.
- Espelhar, virar, girar 90° e 11 modos de mistura.
- Recorte e máscaras com borda suave: linear, retângulo, círculo, coração e estrela.
- Cor completa na GPU: exposição, temperatura, tonalidade, matiz, realces, sombras, nitidez, vinheta, granulado, desbotar, HSL por cor e curvas com pontos arrastáveis.
- Chroma key com conta-gotas e efeitos combináveis: desfoque, brilho, glitch, pixelar, tremor e retrô.
- Fundo da tela em cor, imagem ou vídeo desfocado. Fica no painel quando nenhum clipe está selecionado.
- Brilho, contraste, saturação, velocidade, volume e fades de áudio.
- Transições: dissolver, passar pelo preto, deslizar e cortina.
- Formatos 16:9, 9:16, 1:1 e 4:5.
- Desfazer e refazer, com salvamento automático no navegador.
- Vários projetos no mesmo navegador, em **Projetos**. **Novo** guarda o atual, e as mídias só saem quando um projeto é apagado.
- Salvar e Abrir usam um arquivo `.retalho` com o projeto e as mídias juntos. Use como backup ou para trocar de computador.
- Exporta MP4 (H.264 e AAC) quadro a quadro, com escolha de resolução, de 720p a 4K, e de 24 a 60 quadros por segundo.
- Exporta também GIF, só o áudio (WAV), o quadro atual (PNG) e as legendas (SRT), do projeto inteiro ou de um trecho.
- Desfoque de movimento na exportação, para deixar animações mais naturais.
- Importa legendas SRT em UTF-8 ou Windows-1252.
- Importa LUTs 3D no formato `.cube` e fontes `.ttf`, `.otf` e `.woff`, que também vão no arquivo `.retalho`.
- Importa `draft_content.json` do CapCut, com marcadores e espelhamento. Depois, importe as mídias originais com o mesmo nome para reconectá-las.

## Fala e legendas automáticas

Em **Áudio → Fala**, o Whisper transcreve o clipe no próprio computador, com o tempo de cada
palavra. O modelo (73 ou 238 MB) vem do Hugging Face no primeiro uso e fica guardado no navegador.
O áudio não é enviado para lugar nenhum, e não há custo.

Na aba **Fala**, à esquerda, clique em uma palavra para ir até ela, use Shift+clique para
marcar um trecho e **Cortar trecho** para removê-lo do vídeo. Dois cliques corrigem uma palavra.
Os cortes levam junto legendas, marcadores e faixas da mesma mídia, e deixam a música de fundo inteira.

Para usar todos os núcleos do processador, o site precisa dos cabeçalhos
`Cross-Origin-Opener-Policy: same-origin` e `Cross-Origin-Embedder-Policy: require-corp`. O
`npm run dev` já os envia. Sem eles funciona igual, só que mais devagar.

## Vídeos longos

Acima de 20 minutos ou 768 MB, o som é lido do arquivo em partes, em vez de ser carregado na
memória. A exportação grava direto em um arquivo temporário, então o tamanho do vídeo final não
depende da memória, só do espaço em disco.

O botão **Preview leve** edita com cópias de 540p dos vídeos grandes, guardadas no navegador. A
exportação sempre usa os originais. Trocar de projeto apaga essas cópias.

## Cor e efeitos

O visual de cada clipe roda na GPU com WebGL2 (`src/engine/gpu.ts`), e o resultado volta para o
compositor em Canvas 2D, que monta a cena. Sem WebGL2, o painel avisa e esses ajustes não aparecem.

## Onde fica cada coisa

O painel da direita mostra uma categoria por vez, escolhida na barra de ícones, e categorias maiores têm seções. Cada tipo de clipe
mostra só o que se aplica a ele, e um ponto âmbar marca as categorias com algo aplicado. Sem clipe
selecionado, o painel mostra o fundo da tela. As setas ↑ e ↓ trocam de categoria.

Para adicionar um recurso, crie uma página na lista `CLIP_PAGES` em `src/ui/panel/pages.tsx`, ou um
grupo em uma página que já existe.

## Atalhos

| Tecla | Ação |
| --- | --- |
| Espaço | Reproduzir ou pausar |
| S | Dividir no cursor |
| M | Adicionar ou remover marcador |
| [ ] | Ir ao marcador anterior ou seguinte |
| Ctrl+C, Ctrl+X, Ctrl+V | Copiar, recortar, colar no cursor |
| Ctrl+D | Duplicar |
| Ctrl+clique | Adicionar ou tirar da seleção |
| Ctrl+A | Selecionar tudo |
| Ctrl+G | Agrupar ou desagrupar os selecionados |
| Ctrl+Shift+V | Colar atributos |
| Delete | Excluir (Shift fecha o espaço) |
| ← → | Um quadro (Shift: dez) |
| Home | Início |
| Ctrl+Z, Ctrl+Y | Desfazer, refazer |

## Limitações

- Efeitos, animações e modelos de legenda de drafts do CapCut não são convertidos, porque dependem dos pacotes dele. O importador lista o que ficou de fora.
- Máscara e recorte não têm keyframes, e a suavização vale para todos os keyframes do clipe.
- Transições importadas viram dissolve, e o tamanho do texto importado é aproximado.
- A redução de ruído é para ruído constante, como chiado ou ventilador. Ela aprende com os trechos mais silenciosos do clipe, então funciona pior em áudio sem pausas.
- Ao mudar a velocidade, a reprodução usa o tom alterado até o clipe terminar de ser processado. A exportação sempre espera.
- Efeitos que processam o clipe inteiro, como reduzir ruído e manter o tom, carregam esse trecho na memória, o que pesa em clipes muito longos.
- A transcrição erra palavras, principalmente nomes próprios, e por isso vale revisar antes de exportar.
- Sem remoção de fundo por IA.
- O áudio sai só em WAV, e as legendas só em SRT.
- O arquivo `.retalho` contém as mídias inteiras, então tem o tamanho delas somadas.

## Estrutura

| Pasta | Conteúdo |
| --- | --- |
| `src/core` | Modelo, operações da timeline, keyframes, resolução de quadros e importador. TypeScript puro, sem navegador |
| `src/engine` | Mídia, compositor em Canvas, player, áudio, exportação e persistência |
| `src/ui` | Interface em React |

## Automação para agentes

Um agente de IA, ou um script, monta um vídeo inteiro no próprio editor, sem clicar em nada:

```bash
npm run agente -- render caminho/plano.json
```

O plano lista as mídias e os passos: cortes, enquadramento, texto, legendas palavra por palavra, animações e som. O comando devolve o MP4, o projeto `.retalho` e uma folha de contato, com o som já em -14 LUFS. O guia prático está em [docs/AGENTE.md](docs/AGENTE.md), e os comandos em [docs/AUTOMACAO.md](docs/AUTOMACAO.md).

## Testes

```bash
npm test        # regras do núcleo
npm run e2e     # usa o editor no Chrome e confere o MP4 exportado
```

Para incluir um draft real, defina `RETALHO_REAL_DRAFT` com o caminho do `draft_content.json`.
Para testar a transcrição, defina `RETALHO_SPEECH_WAV` com uma gravação das frases do teste.
A automação para agentes está em [docs/AUTOMACAO.md](docs/AUTOMACAO.md).
