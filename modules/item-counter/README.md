# Contagem na linha (`@streitt/item-counter`)

Conta itens que cruzam uma linha virtual numa câmera ao vivo: sacos saindo
da empacotadora, caixas numa esteira, peças caindo de uma calha. Cada item é
rastreado entre quadros e contado **uma única vez** quando seu centro cruza a
linha. O painel mostra o total, quantos itens estão "a caminho", o último item
recortado, o tempo desde o item anterior e a confiança.

- TypeScript puro, **sem dependências de runtime**; roda no navegador
  (câmera via `getUserMedia`), em WebView e no Node.js.
- ~3–5 ms por quadro no detector padrão (480×270 a 1280×720), bem abaixo
  dos 33 ms de um vídeo a 30 fps.
- Detector e contagem são separados. O detector padrão usa movimento contra
  um fundo aprendido. Um modelo treinado (YOLO, TF.js, ONNX) pode substituí-lo
  para também classificar o item ("Saco 61%"), sem mudar o rastreamento nem a
  linha.

## Uso

```ts
import { LineCounter, MotionDetector } from "@streitt/item-counter";

const detector = new MotionDetector();
const counter = new LineCounter({
  line: { from: { x: 0, y: 300 }, to: { x: 640, y: 300 } },
  direction: "left-to-right", // descendo, para uma linha desenhada da esquerda para a direita
});

function onFrame(frame: ImageData, timeMs: number) {
  const state = counter.update(detector.detect(frame), timeMs);
  state.count; // total contado
  state.approaching; // itens a caminho da linha
  for (const event of state.newEvents) {
    event.index; // item #N
    event.intervalMs; // tempo desde o item anterior
    event.confidence; // 0..1
    event.box; // onde o item estava ao cruzar
  }
}
```

### Com um modelo treinado

`LineCounter.update` aceita detecções de qualquer origem:

```ts
const detections = modelOutput.map((d) => ({
  box: d.box,
  center: { x: d.box.x + d.box.width / 2, y: d.box.y + d.box.height / 2 },
  areaPx: d.box.width * d.box.height,
  score: d.score, // entra na confiança do evento
  label: d.className, // aparece no evento ("saco")
}));
counter.update(detections, timeMs);
```

### Opções

| `LineCounter`      | Padrão   | Descrição                                                                    |
| ------------------ | -------- | ---------------------------------------------------------------------------- |
| `line`             | —        | Segmento `{ from, to }` em pixels do quadro.                                 |
| `direction`        | `either` | `left-to-right` ou `right-to-left`, andando de `from` para `to`.             |
| `minTrackFrames`   | `2`      | Quadros rastreados antes de uma travessia contar (descarta reflexos).        |
| `maxMissedFrames`  | `8`      | Quadros sem ver o item antes de encerrar o rastro (oclusões curtas).         |
| `minMatchDistance` | `24`     | Distância mínima de associação entre quadros, em pixels.                     |
| `deadZone`         | `2`      | Faixa em volta da linha onde o item mantém o lado anterior (evita recontar). |

| `MotionDetector`         | Padrão  | Descrição                                                         |
| ------------------------ | ------- | ----------------------------------------------------------------- |
| `workWidth`              | `192`   | Largura interna de processamento.                                 |
| `threshold`              | `28`    | Diferença mínima por canal em relação ao fundo.                   |
| `learningRate`           | `0.04`  | Adaptação do fundo onde nada se move (luz que muda devagar).      |
| `foregroundLearningRate` | `0.002` | Adaptação sob objetos; baixa para um saco parado não virar fundo. |
| `minAreaFraction`        | `0.002` | Menor objeto, como fração da área do quadro.                      |

## Demonstração

```sh
npm install
npm run demo   # http://127.0.0.1:5173/
```

**Usar câmera** abre a câmera traseira, **Abrir vídeo** processa uma gravação
da linha e **Ver exemplo** gera uma linha de ensacamento animada na própria
página. Arraste sobre a imagem para desenhar a linha de contagem. O navegador
só libera a câmera em `localhost` ou HTTPS; para testar no celular, sirva a
demo por HTTPS ou grave um vídeo e use **Abrir vídeo**.

## Validação

```sh
npm test          # node --test
npm run typecheck
```

- **Rastreador** (detecções injetadas): conta uma vez por item; reporta o
  intervalo entre itens; não reconta item tremendo sobre a linha; não conta
  item que se aproxima e recua; respeita o sentido; ignora travessias fora do
  segmento; separa itens lado a lado; mantém o item numa oclusão curta;
  ignora reflexos de um quadro; propaga rótulo e score do detector.
- **Detector + rastreador** em vídeo sintético: sacos em sequência e lado a
  lado contados; cena parada com ruído e oscilação de luz não conta nada.
- **Estresse**: 40 sequências aleatórias (2–6 sacos, velocidades, tamanhos,
  intervalos e ruído variados): 40 contagens exatas.
- **Navegador**: a demo no Chromium com o vídeo sintético entregue como
  câmera (`getUserMedia`) contou os 4 sacos com 1,0 s de intervalo; o exemplo
  animado contou 5 em 6 s, no desktop e com 400 px de largura.

Esses resultados vêm de cenas sintéticas. A precisão numa linha real precisa
ser medida com vídeos dela.

## Limitações

- A câmera precisa ficar fixa; se ela se mover, use **Reaprender fundo**.
- O detector de movimento conta qualquer objeto que cruza a linha (inclusive
  mãos ou peças da máquina que atravessem o segmento). Posicione a linha onde
  só o produto passa, ou use um modelo treinado com rótulos.
- Itens colados que cruzam juntos viram um único objeto para o detector de
  movimento; um modelo de detecção por instância resolve esse caso.
- Sombras fortes e reflexos que mudam rápido podem gerar falsos objetos;
  `threshold` e `minAreaFraction` ajustam a sensibilidade.
