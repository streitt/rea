# Contador de chapas (`@streitt/sheet-counter`)

Módulo para contar chapas empilhadas (drywall, compensado, MDF, OSB, chapas
metálicas, papelão) a partir de uma foto da lateral da pilha, no estilo do
[CountThings](https://countthings.com/): o operador fotografa a pilha,
enquadra a área, recebe o total com um marcador numerado em cada chapa e
corrige manualmente o que for preciso.

- TypeScript puro, **sem dependências de runtime**: roda no navegador
  (`ImageData` do canvas), em React Native/WebView e no Node.js.
- Determinístico e local: nenhuma imagem sai do dispositivo.
- Cada chapa vem com a **base da evidência** (observada entre juntas, inferida
  de um espaçamento regular, ou borda da pilha) e uma confiança, para que a
  plataforma possa destacar o que precisa de conferência humana.

> Implementação própria (clean-room). Não usa código, modelos ou dados do
> CountThings; o produto deles serviu só como referência de experiência de uso.

## Uso

```ts
import { countSheets } from "@streitt/sheet-counter";

const result = countSheets(imageData, {
  region: { x: 105, y: 92, width: 275, height: 161 }, // área da pilha
  orientation: "horizontal", // chapas deitadas, juntas horizontais
});

if (result.ok) {
  result.value.count; // 29
  result.value.sheets; // [{ index, center: {x,y}, basis, confidence }, ...]
  result.value.warnings; // ["low-confidence-sheets"]
} else {
  result.error.kind; // "no-periodic-structure" | "region-too-small" | ...
}
```

`imageData` é qualquer `{ width, height, data }` RGBA — o `ImageData` do
canvas serve diretamente. No servidor, decodifique com a biblioteca que a
plataforma já usa, por exemplo `sharp`:

```ts
const { data, info } = await sharp(buffer)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
countSheets({ width: info.width, height: info.height, data }, { region });
```

### Opções

| Opção           | Padrão         | Descrição                                                                        |
| --------------- | -------------- | -------------------------------------------------------------------------------- |
| `region`        | imagem inteira | Retângulo que enquadra a pilha da primeira à última chapa.                       |
| `orientation`   | `horizontal`   | `horizontal`: chapas deitadas. `vertical`: chapas em pé, lado a lado.            |
| `jointPolarity` | `auto`         | Junta mais escura (`dark`) ou mais clara (`bright`) que a face da chapa.         |
| `thicknessPx`   | —              | `{ min, max }` da espessura de uma chapa em pixels, quando conhecida.            |
| `strips`        | `12`           | Faixas independentes através da pilha (robustez a oclusão e inclinação).         |
| `fillGaps`      | `true`         | Inferir juntas invisíveis em intervalos de 2+ espessuras com aparência de chapa. |

### Resultado

| Campo         | Significado                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------- |
| `count`       | Total de chapas.                                                                            |
| `breakdown`   | Quantas são `between-joints` (observadas), `gap-split` (inferidas) e `stack-edge` (bordas). |
| `sheets`      | Marcadores ordenados ao longo da pilha, com posição na imagem, base e confiança (0–1).      |
| `joints`      | Linhas das juntas na imagem; `inferred` e `stripAgreement` (fração de faixas que a viram).  |
| `thicknessPx` | Espessura estimada de uma chapa, em pixels.                                                 |
| `skew`        | Inclinação das juntas (pixels ao longo por pixel através).                                  |
| `periodicity` | Força do padrão repetitivo (autocorrelação), 0–1.                                           |
| `warnings`    | `weak-periodicity`, `gaps-filled`, `low-confidence-sheets`, `irregular-spacing`.            |

Erros esperados vêm como `Result` com `kind` explícito; o módulo não lança
exceções para entradas inválidas.

## Como funciona

1. **Faixas**: a área é dividida em faixas paralelas ao eixo da pilha; cada uma
   gera um perfil de luminância.
2. **Espessura**: a autocorrelação do gradiente de cada faixa revela o período
   (espessura da chapa). A mediana entre faixas ignora oclusões com textura
   própria (a mão do operador), e submúltiplos exatos do pico mais forte são
   preferidos para evitar contar de duas em duas.
3. **Inclinação**: a correlação cruzada entre faixas vizinhas mede a
   inclinação das juntas (foto torta ou em perspectiva). Se ela borrar as
   juntas dentro de uma faixa, os perfis são recalculados já endireitados.
4. **Perfil alinhado**: mediana entre faixas alinhadas, com remoção de
   iluminação por um filtro de exatamente um período.
5. **Juntas**: máximos com supressão de não-máximos a 0,6 período (textura da
   face não vira junta), prominência mínima e concordância entre faixas. A
   polaridade (junta escura ou clara) é escolhida pela regularidade.
6. **Lacunas e bordas**: intervalos de k períodos com aparência de chapa
   recebem k−1 juntas inferidas; a primeira e a última chapa só contam quando
   a faixa de borda se parece com as chapas vizinhas — fundo não vira chapa.

## Demonstração

```sh
npm install
npm run demo   # http://127.0.0.1:5173/
```

Escolha ou tire uma foto, arraste para enquadrar a pilha e toque em
**Contar**. Toque num número para removê-lo ou num espaço vazio para adicionar
uma chapa; **Exportar JSON** salva o total final, a contagem detectada, os
ajustes manuais e a análise completa (útil para auditoria e para coletar
dados de calibração).

## Validação

```sh
npm test         # testes com imagens sintéticas (node --test)
npm run typecheck
```

- **Testes**: pilha limpa, 60 chapas com ruído/inclinação/iluminação
  irregular, mão cobrindo 30% da pilha, junta invisível (inferida e
  reportada como inferência), enquadramento folgado com fundo, juntas claras,
  chapas em pé, posição dos marcadores e entradas inválidas.
- **Varredura aleatória** (1.050 cenas sintéticas: 10–80 chapas de 6–26 px,
  ruído até ±20, inclinação até ±6%, oclusão até 35%, gradiente de luz,
  juntas de 1–3 px): 1.047 exatas, 3 com erro de ±1 (todas com chapas de
  ~6 px e inclinação forte), nenhuma com erro maior.
- **Foto real** (pilha verde da imagem de referência, 639×359 px, chapas de
  ~5,5 px): 29 chapas detectadas numa área de 161 px; a estimativa visual é
  de ~30. Sem gabarito exato nessa resolução.

Esses números vêm de imagens sintéticas e de uma foto em baixa resolução; a
precisão em campo precisa ser medida com fotos reais da operação (veja abaixo).

## Limitações e próximos passos

- Assume chapas de espessura parecida na área enquadrada. Pilhas mistas devem
  ser contadas por trecho.
- Perspectiva forte (espessura variando muito ao longo da pilha) reduz a
  precisão; peça ao operador para fotografar de frente.
- Abaixo de ~5 px por chapa a contagem fica instável — oriente a aproximar a
  câmera ou usar a foto em resolução total (a demo reduz para 1.600 px no
  lado maior).
- Para a plataforma: guarde o JSON exportado com a foto. As correções manuais
  formam um conjunto de dados rotulado para medir a precisão real e, se
  necessário, treinar um detector próprio no futuro.

## Usando o REA para estudar o CountThings

O REA analisa artefatos **locais** que você possui. Para estudar a
experiência do app de referência (fluxo de telas, configurações expostas,
formato de exportação) na sua máquina:

```sh
# Site/web app aberto num Chrome com depuração remota
rea list-browser-targets http://127.0.0.1:9222 --json
rea inspect-web-page http://127.0.0.1:9222 TARGET_ID --json

# APK Android obtido legitimamente (requer JDK 17+ e jadx-headless-mcp)
export REA_JADX_MCP_JAR=/caminho/jadx-headless-mcp-0.7.1-all.jar
rea inspect-android-package /caminho/countthings.apk
```

Veja [docs/browser-observation.md](../../docs/browser-observation.md) e
[docs/android-analysis.md](../../docs/android-analysis.md). Respeite os termos
de uso do produto e a legislação aplicável: use a análise para entender
comportamento e interoperabilidade, não para copiar código, modelos ou dados
proprietários.
