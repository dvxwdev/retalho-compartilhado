# Como o CapCut funciona por dentro

Análise do CapCut para Windows 9.1.0.3879, instalado em `%LOCALAPPDATA%\CapCut`.
Foi só análise estática, com o REA e leitura de arquivos: o app não foi executado
nem depurado. Nada de código, binário ou asset dele foi copiado para o Retalho.

Legenda: **[observado]** está nos arquivos. **[inferido]** é conclusão a partir
do que foi observado. **[desconhecido]** não foi determinado.

## Visão geral

**[observado]** App nativo em C++ com Qt 6 e QML, 64 bits, cerca de 1,6 GB em
4.034 arquivos. Não é Electron. O `CapCut.exe` tem só 86 KB: ele importa
`VESafeGuard.dll`, `VEConfig.dll` e Qt, e o trabalho real está em DLLs.

| Camada | Componentes | Função |
| --- | --- | --- |
| Interface | `Qt6Quick`, `Qt6Qml`, `FusionUI.dll`, `VECreator.dll`, `cccreator.dll` | Janelas, listas, timeline. Não há `.qml` da aplicação solto no disco, então a interface própria fica embutida nas DLLs **[inferido]** |
| Painéis web | `lynx.dll`, `cef/`, `CefCreator.dll` | Conteúdo dinâmico em Lynx e Chromium embutido |
| Modelo do projeto | `videoeditor.dll` (31.641 exports) | Classes `lvve::Draft`, `SegmentVideo`, `MaterialText`, `DraftStore`, `KeyframeVideo` |
| Render e efeitos | `lens.dll`, `Resources/DefaultAdjustBundle`, `.xshader`, `.frag`, `.vert`, `.lua` | Efeitos como pacotes de shader e script, GPU via `VEAngle` |
| Codecs | FFmpeg (`avcodec-61` e outros), `dav1d`, `SvtAv1Enc`, NVENC, AMF, QSV | Decodificar e codificar, com aceleração por hardware |
| Áudio | `audioeffect.dll`, `speechsdk.dll`, `Resources/models/noise_reduction` | Efeitos, voz e redução de ruído |
| IA local | `openvino.dll`, `Resources/models` (118 arquivos, 224 MB) | Recorte, rastreamento, detecção de cena e rosto |
| Serviços | `sscronet.dll`, `ever_cloud_sdk.dll`, `uploader.dll`, `EffectPlatform.dll`, `Tracking.dll` | Rede, nuvem, catálogo de efeitos, telemetria |
| Proteção | `VESafeGuard.dll`, `metasecml.dll` | Não analisados. Ficaram fora do escopo de propósito |

## O modelo do projeto

**[observado]** Cada projeto é uma pasta em
`User Data\Projects\com.lveditor.draft\<nome>`, com o estado em
`draft_content.json`, JSON puro sem criptografia nos drafts analisados.

O desenho central separa três ideias:

- **Material**: o recurso reutilizável. `materials` tem 55 categorias, como
  `videos`, `audios`, `texts`, `speeds`, `transitions`, `effects` e `canvases`.
- **Faixa** (`tracks`): tem `type` `video`, `audio`, `text` ou `effect`.
- **Segmento**: um uso de um material em uma faixa. Aponta para ele com
  `material_id` e para os complementos com `extra_material_refs`.

Por isso cortar um clipe só cria outro segmento, sem tocar na mídia.

Convenções confirmadas nos drafts:

| Item | Convenção |
| --- | --- |
| Tempo | Inteiros em microssegundos |
| Posição no projeto | `target_timerange` |
| Trecho lido da mídia | `source_timerange` |
| Posição do clipe | `clip.transform` normalizado. Legendas ficam em y ≈ -0,72, logo y positivo é para cima **[inferido]** |
| Escala | `clip.scale`, com 1 sendo o encaixe na tela **[inferido]** |
| Volume | Multiplicador que passa de 1 (encontrado 1,88) |
| Transição | Ligada ao segmento que sai, em `extra_material_refs`, com `is_overlap` |
| Keyframes | `common_keyframes`, um grupo por propriedade (`KFTypeScaleX`, `KFTypePositionY`), com tempo relativo ao segmento |
| Ordem de desenho | `render_index`: vídeo a partir de 0, efeitos por volta de 11000, texto por volta de 14000 |

## Pontos em aberto

- **[desconhecido]** A ordem exata do pipeline de render e como o `lens.dll`
  executa os pacotes de efeito. Isso exigiria decompilar ou rodar o app.
- **[desconhecido]** Como a transição distribui o tempo em volta do corte. O
  Retalho centraliza no corte por decisão própria.
- **[desconhecido]** A unidade de `font_size`. O importador usa um fator aproximado.
- **[desconhecido]** O comportamento de rede e nuvem. Só a presença das DLLs foi observada.

## O que isso virou no Retalho

| CapCut | Retalho | Diferença |
| --- | --- | --- |
| Material, faixa e segmento | Mesmo conceito em `src/core/model.ts` | Modelo enxuto, com um campo para cada coisa suportada |
| FFmpeg nativo | WebCodecs e `<video>` | Roda no navegador, sem instalação |
| GPU com shaders | Canvas 2D | Mais simples, com menos efeitos e menos desempenho |
| Efeitos da plataforma | Brilho, contraste, saturação e 4 transições | Sem catálogo online |
| Modelos de IA | Não implementado | Fora do escopo desta versão |
