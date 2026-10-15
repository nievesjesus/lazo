# Ablación de etapas del pipeline sobre LFW

Protocolo de `mnemo-eval` (semilla 0, partición por identidad, τ_alta derivado en validación para FPIR objetivo 1 %, banda 0,08). Sondas de prueba por N en la columna «n»; los intervalos son de Wilson al 95 %.

## Galería N=10

| Configuración | τ_alta | FPIR | FNIR [IC 95 %] | Rango 1 | Abstención | n (gen. / imp.) | FNIR a FPIR = 1 % (τ en prueba) |
|---|---:|---:|---:|---:|---:|---:|---:|
| completa | 0,269 | 0,89 % | 2,63 % [0,5 %–13,5 %] | 97,37 % | 13,15 % | 38 / 1240 | 2,63 % |
| sin alineación | 0,347 | 0,56 % | 5,26 % [1,5 %–17,3 %] | 97,37 % | 7,43 % | 38 / 1240 | 2,63 % |
| sin preprocesamiento | 0,239 | 0,89 % | 2,63 % [0,5 %–13,5 %] | 97,37 % | 17,37 % | 38 / 1240 | 2,63 % |
| sin ambas | 0,324 | 1,21 % | 2,63 % [0,5 %–13,5 %] | 100,00 % | 7,20 % | 38 / 1240 | 5,26 % |

## Galería N=25

| Configuración | τ_alta | FPIR | FNIR [IC 95 %] | Rango 1 | Abstención | n (gen. / imp.) | FNIR a FPIR = 1 % (τ en prueba) |
|---|---:|---:|---:|---:|---:|---:|---:|
| completa | 0,354 | 0,09 % | 3,37 % [1,2 %–9,4 %] | 96,63 % | 1,83 % | 89 / 1114 | 3,37 % |
| sin alineación | 0,396 | 0,27 % | 13,48 % [7,9 %–22,1 %] | 98,88 % | 4,32 % | 89 / 1114 | 7,87 % |
| sin preprocesamiento | 0,328 | 0,00 % | 4,49 % [1,8 %–11,0 %] | 95,51 % | 1,58 % | 89 / 1114 | 4,49 % |
| sin ambas | 0,383 | 0,36 % | 10,11 % [5,4 %–18,1 %] | 97,75 % | 4,32 % | 89 / 1114 | 7,87 % |

## Galería N=50

| Configuración | τ_alta | FPIR | FNIR [IC 95 %] | Rango 1 | Abstención | n (gen. / imp.) | FNIR a FPIR = 1 % (τ en prueba) |
|---|---:|---:|---:|---:|---:|---:|---:|
| completa | 0,384 | 0,11 % | 2,87 % [1,2 %–6,5 %] | 97,70 % | 0,74 % | 174 / 904 | 2,87 % |
| sin alineación | 0,416 | 0,55 % | 14,94 % [10,4 %–21,0 %] | 95,98 % | 5,38 % | 174 / 904 | 13,22 % |
| sin preprocesamiento | 0,348 | 0,00 % | 3,45 % [1,6 %–7,3 %] | 97,13 % | 1,21 % | 174 / 904 | 3,45 % |
| sin ambas | 0,399 | 0,77 % | 9,77 % [6,2 %–15,1 %] | 95,98 % | 5,10 % | 174 / 904 | 9,20 % |

## Población por configuración

| Configuración | Identidades útiles | Validación / prueba | Imágenes sin rostro detectado | Personas con < 2 usables |
|---|---:|---:|---:|---:|
| completa | 311 | 155 / 156 | 1 de 2681 | 0 |
| sin alineación | 311 | 155 / 156 | 1 de 2681 | 0 |
| sin preprocesamiento | 311 | 155 / 156 | 1 de 2681 | 0 |
| sin ambas | 311 | 155 / 156 | 1 de 2681 | 0 |

## Sensibilidad al ancho de la banda de abstención (configuración completa, N = 50)

FNIR, FPIR y rango 1 sólo dependen de τ_alta, que no cambia con la banda: lo que se mueve es τ_baja y, con él, cuántas sondas caen en «no estoy seguro» en lugar de descartarse en silencio.

| Banda | τ_baja | τ_alta | Abstención (todas) | Abstención en impostoras | Abstención en genuinas | FNIR | FPIR |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 0,04 | 0,344 | 0,384 | 0,00 % | 0,00 % | 0,00 % | 2,87 % | 0,11 % |
| 0,08 | 0,304 | 0,384 | 0,74 % | 0,88 % | 0,00 % | 2,87 % | 0,11 % |
| 0,12 | 0,264 | 0,384 | 4,08 % | 4,87 % | 0,00 % | 2,87 % | 0,11 % |
