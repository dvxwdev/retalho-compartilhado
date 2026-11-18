# Guia do agente: criativos com o Retalho

Leia antes de montar um vídeo. Os detalhes de cada comando estão em [AUTOMACAO.md](AUTOMACAO.md), e `npm run agente -- comandos` lista todos com seus argumentos.

## O ciclo

1. **Separe as mídias** numa pasta: clipes, imagens (PNG com fundo transparente para produto), narração, música, efeitos e a fonte `.ttf`. Cada arquivo precisa de um nome único, porque o plano acha as mídias pelo nome.
2. **Escreva o plano** (`plano.json`) ou um script que o gere a partir do tempo das palavras da narração.
3. **Renderize:** `npm run agente -- render caminho/plano.json`.
4. **Olhe a folha de contato** (`<nome>-folha.jpg`). Sem olhar, não entregue.
5. **Corrija o plano** e renderize de novo. Cada render começa de um projeto vazio, então o resultado depende só do plano.
6. **Entregue** o MP4 e o `.retalho`, que abre no editor para ajustes à mão.

O render sai com código 0 quando deu certo, 1 quando o plano ou a validação falhou e 2 quando falta Chrome, arquivo ou servidor. A saída em JSON traz duração, avisos, problemas, o som medido (`lufs`, `picoDb`) e os arquivos gerados.

## O plano

```json
{
  "versao": 1,
  "nome": "criativo-01",
  "projeto": { "nome": "Criativo 01", "largura": 1080, "altura": 1920, "fps": 30, "fundo": "#000000" },
  "midias": ["clipes/", "img/livro.png", "audio/narracao.wav", "audio/musica.wav", "fonts/Anton-Regular.ttf"],
  "audio": { "lufs": -14, "picoMax": -1 },
  "saida": { "pasta": "saida", "mp4": true, "retalho": true, "folha": { "passo": 1, "colunas": 6 } },
  "passos": [
    { "comando": "criarFaixa", "args": { "tipo": "video", "nome": "Cenas" }, "como": "cenas" },
    { "comando": "criarFaixa", "args": { "tipo": "video", "nome": "Produto" }, "como": "produto" },

    { "comando": "adicionarClipe", "args": { "materialId": "@maos.mp4", "inicio": 0, "duracao": 2.4, "inicioFonte": 1, "faixaId": "$cenas" }, "como": "c1" },
    { "comando": "definirEnquadramento", "args": { "clipeId": "$c1", "enquadramento": "cover" } },
    { "comando": "definirKeyframe", "args": { "clipeId": "$c1", "propriedade": "scale", "tempo": 0, "valor": 1.02 } },
    { "comando": "definirKeyframe", "args": { "clipeId": "$c1", "propriedade": "scale", "tempo": 2.4, "valor": 1.1 } },

    { "comando": "adicionarClipe", "args": { "materialId": "@livro.png", "inicio": 1.2, "duracao": 2, "faixaId": "$produto" }, "como": "livro" },
    { "comando": "definirTransformacao", "args": { "clipeId": "$livro", "y": 0.3, "escala": 0.7 } },
    { "comando": "definirAnimacao", "args": { "clipeId": "$livro", "entrada": { "tipo": "pop", "duracao": 0.4 }, "loop": { "tipo": "float", "duracao": 2.6 } } },

    { "comando": "adicionarTexto", "args": { "texto": "SEM PARTITURA", "inicio": 1.5, "duracao": 1.7 }, "como": "selo" },
    { "comando": "estilizar", "args": { "clipeId": "$selo", "estilo": { "fontFamily": "Anton-Regular", "fontSize": 50, "color": "#111111", "bold": false, "background": "#FFD23F", "backgroundPadding": 0.45, "backgroundRadius": 1 } } },
    { "comando": "definirTransformacao", "args": { "clipeId": "$selo", "x": 0.4, "y": 0.28, "rotacao": 6 } },

    { "comando": "adicionarLegendas", "args": {
        "palavras": [{ "texto": "QUEM", "inicio": 0.1, "fim": 0.4 }, { "texto": "TOCA", "inicio": 0.4, "fim": 0.7, "quebra": true }],
        "y": -0.38, "maxPalavras": 3, "maxLetras": 16,
        "estilo": { "fontFamily": "Anton-Regular", "fontSize": 104, "bold": false, "strokeWidth": 9 },
        "destaque": { "cor": "#FFD23F", "escala": 1.12 },
        "entrada": { "tipo": "pop", "duracao": 0.14 } } },

    { "comando": "adicionarClipe", "args": { "materialId": "@narracao.wav", "inicio": 0 }, "como": "voz" },
    { "comando": "adicionarClipe", "args": { "materialId": "@musica.wav", "inicio": 0, "duracao": 30 }, "como": "musica" },
    { "comando": "definirVolume", "args": { "clipeId": "$musica", "volume": 0.2 } },
    { "comando": "definirFades", "args": { "clipeId": "$musica", "saida": 1.4 } }
  ]
}
```

- **`midias`**: caminhos relativos ao plano. Uma pasta importa os arquivos de mídia que estão nela.
- **`"@arquivo"`** acha o material importado por nome. **`"$nome"`** usa o que um passo anterior criou com `"como"`.
- **`projeto`** vira um `definirProjeto` antes dos passos.
- **`audio.lufs`** leva a mixagem inteira a esse volume no fim. O equilíbrio entre voz e música é o dos volumes do plano.
- A fonte importada se chama como o arquivo sem a extensão: `Anton-Regular.ttf` vira `"fontFamily": "Anton-Regular"`.

## Coordenadas e tamanhos

- **`x` e `y`** vão de -1 a 1, em frações de meia tela. `y` positivo sobe: `0.3` fica no terço de cima, `-0.38` é a altura boa para legenda em 9:16.
- **`escala` 1** encaixa a imagem inteira na tela. Um produto ocupando 70% da largura é `0.7` numa imagem quadrada ou vertical.
- **`cover`** preenche a tela. Para mostrar outra parte de um clipe deitado num vídeo vertical, mova com `x`: `x = (1 - 2p) × (larguraNaTela/2 - 540) / 540`, com `p` de 0, a esquerda, a 1, a direita, e `larguraNaTela = largura × 1920 / altura`.
- **`fontSize`** é em pixels de uma tela com o lado menor de 1080.

## Regras de criativo (anúncio 9:16)

- Deixe os 15% de cima e os 20% de baixo livres de texto importante: é onde ficam os botões do Reels e do Stories.
- Corte a cada 2 a 3 segundos e dê um leve zoom em cada cena (`scale` de 1,02 a 1,1).
- Use legenda palavra por palavra: 2 a 3 palavras por vez, a palavra falada em destaque e uma quebra em cada fim de frase (`"quebra": true`).
- Produto sempre por cima das cenas, nunca em tela cheia, com `pop` na entrada.
- Som em -14 LUFS, com pico abaixo de -1 dBFS.

## Erros comuns

| Sintoma | Causa e correção |
|---|---|
| `MATERIAL_NAO_ENCONTRADO: Nenhum material importado se chama "x"` | O nome em `@x` não bate com o arquivo, ou o arquivo não está em `midias` |
| `ARGUMENTO_INVALIDO … referência a um "como"` | Um `$nome` aponta para um passo que vem depois, ou que não existe |
| Texto aparece em fonte comum | `fontFamily` diferente do nome do arquivo da fonte sem a extensão |
| Clipe com faixas pretas | Faltou `definirEnquadramento` com `cover` |
| Aviso "Início ajustado ao espaço livre" | Dois clipes disputando o mesmo tempo na mesma faixa. Crie outra faixa com `criarFaixa` |
| Aviso "Duração limitada ao que resta da fonte" | O clipe é curto para o trecho. Use outro `inicioFonte`, outro clipe ou `definirVelocidade` abaixo de 1 |

## Exemplo real

`oferta faceads/criativos/video2/plano.mjs` gera um plano de 207 passos para um anúncio de 35 s. Ele lê o tempo das palavras da narração (`timeline.json`) e a lista de cenas (`cenas.json`), e faz cortes, preencher com posição, zoom, livro e páginas com moldura, selos, legendas, botão final e som em -14 LUFS.
