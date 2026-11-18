# O que o CapCut tem e o Retalho ainda não

Levantamento do CapCut para Windows 9.1.0.3879, comparado com o código do Retalho
em 2026-11-04. Complementa [ARQUITETURA-CAPCUT.md](ARQUITETURA-CAPCUT.md).

## De onde vêm os dados

| Fonte | O que deu |
| --- | --- |
| Exports de `videoeditor.dll`, com o REA | 31.641 símbolos, 3.102 classes e 2.222 comandos do motor (`U*ReqStruct`) |
| Exports de `audioeffect.dll`, com o REA | 2.102 símbolos do motor de áudio |
| `Resources/po/pt-BR.po` | 15.326 textos da interface, que mostram o que o usuário vê |
| `Resources/models` e demais pastas | 118 arquivos de modelos de IA, predefinições e modos de mistura |
| Strings de `videoeditor.dll` | Tipos de keyframe (`KFType*`) e campos de curva |
| 6 drafts do usuário | O que é realmente usado |

**Limites.** Nomes e textos provam que um recurso existe no app, não como ele funciona nem
se é gratuito. Nada foi executado ou decompilado, e isso foi de propósito: a lista de
recursos não exige isso, e o Retalho não deve reproduzir a implementação do CapCut.
`VESafeGuard.dll` e `metasecml.dll` ficaram fora. `VECreator.dll`, `cccreator.dll` e
`lens.dll` só foram inventariadas. O tamanho dos catálogos online de efeitos, adesivos e
transições é desconhecido, porque eles não ficam no disco.

**Regra.** Tudo abaixo deve ser implementado do zero. Modelos, shaders, fontes, LUTs,
pacotes de efeito e sons do CapCut não podem ser reaproveitados.

## O que você mais usa e o Retalho não cobre

Contagem real dos 6 drafts, sem as entradas que o CapCut cria sozinho. Dividir um clipe copia
os marcadores para cada pedaço, então eles foram contados sem repetição. As batidas estão
contadas por clipe e podem ter a mesma repetição:

| Uso no CapCut | Quantidade | Situação no Retalho |
| --- | --- | --- |
| Marcadores distintos | 5 | Falta (item 7) |
| Animações de legenda | 11 | Falta (item 41) |
| Modelos de texto | 11 | Falta (item 42) |
| Clipes com batidas marcadas | 9 | Falta (item 58) |
| Efeitos de áudio | 8 | Falta (itens 50 a 57) |
| Efeitos e ajustes visuais (bloom, vinheta, nitidez, desbotar) | 9 | Falta (itens 27 a 36) |
| Clipes com keyframes | 7 | Existe, sem suavização (item 13) |

## Legenda

**Esforço:** P é de horas a 1 dia. M é de alguns dias. G é de 1 semana ou mais.

**Base necessária:**
- **Pronto**: dá para fazer com o que já existe.
- **GPU**: exige o compositor em WebGL2.
- **Áudio**: exige a cadeia de efeitos de áudio.
- **IA**: exige modelo aberto rodando no navegador.

## Timeline e edição

| # | Recurso | Evidência no CapCut | Esforço | Base |
| --- | --- | --- | --- | --- |
| 1 | Copiar, colar e duplicar clipes | `MultiCopySegments`, `MultiPasteSegments`, "Duplicar" | P | Pronto |
| 2 | Copiar e colar atributos | "Copiar atributos", `CopyAudioAttribute` | P | Pronto |
| 3 | Selecionar vários clipes | `MultiMoveSegments`, `MultiCutRemoveSegment` | M | Pronto |
| 4 | Agrupar e desagrupar | "Agrupar", `RemoveSegmentGroup` | M | Pronto |
| 5 | Bloquear faixa | "Bloquear trilha" | P | Pronto |
| 6 | Ímã da faixa principal | "Ímã da faixa principal" | M | Pronto |
| 7 | Marcadores coloridos | "Adicionar marcador", `MaterialTimeMark` | P | Pronto |
| 8 | Congelar quadro | "Congelar", `FreezeInfo` | P | Pronto |
| 9 | Inverter clipe | "Inverter", `ConvertReverseVideo` | M | Pronto |
| 10 | Substituir clipe mantendo os ajustes | "Substituir clipe", `ReplaceSegmentVideo` | P | Pronto |
| 11 | Clipe composto (subprojeto) | "Criar clipe composto", `AddComposition` | G | Pronto |
| 12 | Curva de velocidade | "Curva livre", `curve_speed_points` | G | Pronto |
| 13 | Suavização de keyframes | `curveType`, `left_control`, `right_control` | M | Pronto |
| 14 | Painel gráfico de keyframes | "Exibir gráficos de quadro-chave" | G | Pronto |
| 15 | Keyframes em cor, volume e texto | `KFTypeBrightness`, `KFTypeVolume`, `KFTypeTextColor` | M | Pronto |
| 16 | Predefinições de keyframe | `ApplyCommonKeyframesPreset` | P | Pronto |
| 17 | Multicâmera | `AddMultiCamera`, "Visualização multicâmera" | G | Pronto |
| 18 | Atalhos personalizáveis | "Clique para modificar o atalho", "Conflito de atalhos" | M | Pronto |

## Enquadramento e composição

| # | Recurso | Evidência no CapCut | Esforço | Base |
| --- | --- | --- | --- | --- |
| 19 | Espelhar e girar 90° | "Espelhar", "Girar no sentido horário" | P | Pronto |
| 20 | Recortar clipe | `Crop`, `TemplateVideoCrop` | M | Pronto |
| 21 | Fundo da tela: cor, desfoque ou imagem | `UpdateCanvasBackgroundBlur`, `...Color`, `...Image` | M | Pronto |
| 22 | Modos de mistura | `MixMode.json` lista 10, como multiplicar e luz suave | P | Pronto |
| 23 | Máscaras: linear, círculo, retângulo, coração e estrela | `MaterialCommonMask`, `KFTypeCommonMaskFeather` | M | Pronto |
| 24 | Guias e réguas no preview | "Guias e réguas", "Adicionar guia horizontal" | P | Pronto |
| 25 | Cantos arredondados, contorno e sombra no clipe | `MaterialRoundRadius`, `MaterialVideoStroke`, `MaterialVideoShadow` | M | Pronto |
| 26 | Corner pin (distorção pelos 4 cantos) | `KFTypeCornerPinUpLeft`, `CornerPinInfo` | M | GPU |

Modos como `linear_deepening` não têm equivalente direto no Canvas 2D e ficam para a base GPU.

## Cor e efeitos visuais

| # | Recurso | Evidência no CapCut | Esforço | Base |
| --- | --- | --- | --- | --- |
| 27 | Temperatura, matiz, exposição, realces e sombras | `DefaultAdjustBundle`, `KFTypeTemperature`, `KFTypeHightLight` | M | GPU |
| 28 | Nitidez, vinheta, granulado e desbotar | `sharpen`, `vignetting`, `particle`, `fade` | M | GPU |
| 29 | HSL por cor | `MaterialHsl` | M | GPU |
| 30 | Curvas de cor | `MaterialColorCurves`, `MaterialHslCurves` | M | GPU |
| 31 | Rodas de cor | `MaterialPrimaryColorWheels`, `MaterialLogColorWheels` | M | GPU |
| 32 | Importar LUT `.cube` | "Importar LUT" | M | GPU |
| 33 | Ajuste global por faixa | `AddGlobalAdjust`, `AddGlobalFilter` | M | GPU |
| 34 | Predefinições de ajuste e filtros próprios | "Salvar como predefinição" | M | GPU |
| 35 | Chroma key | `SetChromaColor`, `SetChromaIntensity`, `SetChromaSpill`, `SetChromaEdgeSmooth` | M | GPU |
| 36 | Efeitos próprios: brilho, desfoque, glitch e tremor | `MaterialVideoEffect`, `KFTypeBloomStrength` | M a G | GPU |
| 37 | Mais transições, criadas do zero | `MaterialTransition` | M | GPU |
| 38 | Escopos de cor | "Escopo", `RegisterScopeImageReceivedCallback` | M | GPU |

## Texto, legendas e gráficos

| # | Recurso | Evidência no CapCut | Esforço | Base |
| --- | --- | --- | --- | --- |
| 39 | Sombra, alinhamento, espaçamento e texto curvo | `KFTypeShadowAngle`, `KFTypeTextCurveAngle` | M | Pronto |
| 40 | Estilo por palavra | `RichTextUtils`, `CaptionKeywords` | M | Pronto |
| 41 | Animações de entrada, saída e loop | `MaterialAnimations`, `CaptionAnim` | M | Pronto |
| 42 | Modelos de texto próprios | `MaterialTextTemplate` | M | Pronto |
| 43 | Importar e exportar SRT, LRC e ASS | "Legendas SRT, LRC e ASS" | P | Pronto |
| 44 | Painel de legendas com busca e troca | "Encontrar e substituir" | M | Pronto |
| 45 | Fontes do usuário | "Fonte importada" | P | Pronto |
| 46 | Formas | `MaterialShape`, `KFTypeShapeRoundness` | M | Pronto |
| 47 | Adesivos do usuário e GIFs | `MaterialSticker`, `StickerAnimation` | M | Pronto |
| 48 | Desenho à mão | `HandwriteDraw`, `MaterialHandwrite` | M | Pronto |
| 49 | Gráficos animados: barras, pizza e linhas | "Gráfico de barras dinâmico" | G | Pronto |

## Áudio

| # | Recurso | Evidência no CapCut | Esforço | Base |
| --- | --- | --- | --- | --- |
| 50 | Panorâmica estéreo | `MaterialAudioPanning`, `KFTypeAudioPanning` | P | Áudio |
| 51 | Equalizador | Classe `Equalizer` | M | Áudio |
| 52 | Compressor e limitador | `CLimiterV2`, `Exciter` | M | Áudio |
| 53 | Normalizar volume | `LoudNorm3`, `AudioLoudnessUnify` | M | Áudio |
| 54 | Baixar a música quando há voz | Classe `Ducker` | M | Áudio |
| 55 | Reverb | Classe `Reverb` | M | Áudio |
| 56 | Manter o tom ao mudar a velocidade | `TimeStretcher`, `PitchTempoAdjuster`, `is_tone_modify` | M | Áudio |
| 57 | Mudança de tom e voz | `MaterialAudioPitchShift`, `AudioChangeVoice` | M | Áudio |
| 58 | Detecção de batidas | `BeatTrackingOffline`, `AddAudioBeat` | M | Áudio |
| 59 | Corte no ritmo da batida | `BeatSpeedInfo`, `GenerateCurveSpeedPointsFromBeats` | M | Áudio |
| 60 | Redução de ruído | `RNNoise48k`, `AudioRealtimeDenoise` | M | Áudio |
| 61 | Gravar narração | "Locução", `RecorderNode` | P | Pronto |
| 62 | Extrair áudio de um vídeo | "Extrair áudio" | P | Pronto |
| 63 | Medidor de volume | `AudioIndicatorParam`, `VolumeDetectorX` | P | Pronto |
| 64 | Sincronizar câmera e áudio externo (função inferida pelo nome) | Modelos `time_align_*_domain` | G | Áudio |

## Exportação, projeto e desempenho

| # | Recurso | Evidência no CapCut | Esforço | Base |
| --- | --- | --- | --- | --- |
| 65 | Escolher resolução e FPS (24, 25, 30, 50 ou 60) | "Resolução", "Taxa de quadros", "60 fps" | P | Pronto |
| 66 | Escolher taxa de bits e codec | "VBR", "CBR", "Codec:" | P | Pronto |
| 67 | Exportar só o áudio | "Exportar áudio", "MP3 e WAV" | P | Pronto |
| 68 | Exportar quadro parado | "Exportar quadro parado" | P | Pronto |
| 69 | Exportar GIF | "Exportar GIF em 640P" | M | Pronto |
| 70 | Exportar trecho ou clipes selecionados | "Exportar clipes selecionados" | P | Pronto |
| 71 | Capa do vídeo | `AddCoverVideo`, `AddCoverText` | M | Pronto |
| 72 | Marca d'água própria | `AddBrandWatermark` | P | Pronto |
| 73 | Salvar e abrir projeto em arquivo | "Fazer backup" (lá é nuvem) | P | Pronto |
| 74 | Vários projetos | `DraftStoreManager`, lista de rascunhos | M | Pronto |
| 75 | Vídeos longos sem pesar a memória | `SegmentPreRenderCacheManager`, "Proxy" | G | Pronto |
| 76 | Proxy de baixa resolução | "Ativar o proxy" | G | Pronto |
| 77 | Gravar tela e câmera | "Gravar tela", "Tela e câmera" | M | Pronto |

## IA que pode rodar no navegador

Sem servidor, com modelos abertos e licença a conferir caso a caso.

| # | Recurso | Evidência no CapCut | Caminho no Retalho | Esforço |
| --- | --- | --- | --- | --- |
| 78 | Legendas automáticas | "Legendas automáticas", `RecognizedSubtitleWord` | Whisper com WebGPU | G |
| 79 | Editar o vídeo pela transcrição | `TranscriptEditSentence`, "Edição baseada em transcrição" | Depende do item 78 | G |
| 80 | Cortar pausas e palavras de preenchimento | "Detectar pausas acima de", "Palavras de preenchimento" | Pausas por volume; palavras pelo item 78 | M a G |
| 81 | Detecção de cenas | `jy_compressShotDetect*`, "Dividir cenas" | Diferença entre quadros, sem IA | M |
| 82 | Remover fundo | `mattingmodel`, "Remover plano de fundo" | Segmentação aberta com GPU | G |
| 83 | Reenquadrar para 9:16 | `SmartCropUtils`, `lvop_intelligent_crop` | Detecção de rosto ou objeto | G |
| 84 | Tradução de legendas | `MaterialAiTranslate` | Modelo local, com qualidade limitada | G |
| 85 | Rastrear objeto | `VideoTracker`, `object_tracking` | Rastreador em GPU ou modelo aberto | G |
| 86 | Estabilizar | `VideoStable`, "Nível de Estabilização" | Fluxo óptico próprio | G |
| 87 | Câmera lenta suave | `interpolation`, "Fluxo óptico" | Pesado no navegador | G |
| 88 | Super resolução | `SuperResolution` | Pesado no navegador | G |
| 89 | Texto para fala | "Conversão de texto em fala" | Modelo local aberto | G |
| 90 | Separar voz e música | `MaterialVocalSeparation`, `AudioSeparateSound` | Modelo aberto, lento | G |

## Não vale a pena ou não dá para trazer

| Recurso do CapCut | Motivo |
| --- | --- |
| Catálogo de efeitos, adesivos, músicas e modelos | É conteúdo licenciado. Só faz sentido criar acervo próprio |
| Avatares digitais e clonagem de voz | Exigem modelos grandes e têm risco de uso indevido |
| Geração de vídeo, imagem e música por IA | Exigem serviço pago com GPU |
| Beleza, afinar rosto e corpo | Muito esforço e pouco valor, a menos que seja seu foco |
| Backup na nuvem e equipes | Exigem servidor, contas e custo mensal |
| Publicar direto no TikTok ou YouTube | Exige servidor e aprovação das APIs |
| Criador de anúncios, roteiros e vídeos por artigo | É produto à parte, baseado em serviço de IA |

Geração de roteiro, títulos e música por IA só entra com servidor ou chave de API do usuário.

## Ordem recomendada

1. **Ganhos rápidos, sem nova base (feito):** itens 1, 2, 5, 7, 8, 19, 22, 43, 61, 62, 65, 67, 68 e 73.
   Do item 43 ficaram de fora LRC e ASS, e do item 67, o MP3.
2. **Sua forma de editar (feito):** itens 13, 41, 42, 39, 21, 23 e 20.
   Máscara e recorte ainda não têm keyframes.
3. **Base de áudio (feito):** itens 50, 53, 56, 60 e 58.
   A redução de ruído é própria e cobre ruído constante, não vozes ao fundo ou barulhos súbitos.
4. **Base GPU (feito):** itens 27, 28, 32, 35 e 36. A GPU aplica o visual de cada clipe, e o Canvas 2D
   segue montando a cena. Dos outros itens que dependem dela, faltam 26, 31, 34 e 38.
5. **Legendas com IA (feito):** itens 78, 79, 80 e 81. Roda no processador, com Whisper base ou small.
6. **Vídeos longos (feito):** itens 75 e 76. Som lido em partes, exportação direto no disco e preview leve em 540p.


## Situação depois dos grupos 1 a 6

Entregue além dos grupos marcados como feitos:

- 3 e 4: seleção múltipla e grupos.
- 9: inverter clipe.
- 13: a curva agora vale para todos os keyframes ou só para o do cursor.
- 15: keyframes de cor e de intensidade de efeitos. Volume e texto ainda não têm.
- 25: cantos, contorno e sombra no clipe.
- 29, 30, 33 e 37: HSL, curvas, camada de ajuste e novas transições.
- 44: lista de legendas com busca e troca.
- 45 e 46: fontes do usuário e formas com gradiente, contorno e entrada desenhada.
- 51, 52, 54, 55 e 59: equalizador, compressor, redução da música sob a voz, reverb e corte na batida.
- Fora da lista: vários projetos salvos, modelos animados, animação letra a letra, movimentos de câmera, legendas estilo karaokê, exportação em GIF e desfoque de movimento.

Ainda em aberto, entre os que mais fariam diferença: 11 (clipe composto), 12 (curva de velocidade), 14 (painel gráfico de keyframes), 26 (corner pin), 31 (rodas de cor), 34 (predefinições de ajuste) e 38 (escopos de cor).
