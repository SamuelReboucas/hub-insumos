import { Hono } from 'hono'
import { cors } from 'hono/cors'

type DB = {
  query:(sql:string,params?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>
  exec:(sql:string,params?:unknown[])=>Promise<{rowsWritten:number}>
}
type Env={DB:DB;RESEND_API_KEY:string;ALERT_EMAIL:string;WEBHOOK_SECRET:string;FROM_EMAIL:string;GOOGLE_CHAT_WEBHOOK:string}

const MARCAS_ESPERADAS=['BB','AP','LE','KOKESHI','RITUÁRIA']
const WEEKS_PER_MONTH=4.43
const ANOMALIA_FACTOR=2.50
const SCHEMA_VERSION=11
const DIAS_MES=30.4
// Lead times oficiais por insumo (produção + atendimento do pedido + entrega
// no CD). Substituem o lead time genérico de 21 dias usado anteriormente
// para caixas e Fita Gomada.
// ── Transição de fonte da Fita Gomada da RITUÁRIA (v74) ──────────────────────
// RITUÁRIA passou a reportar a fita personalizada em coluna PRÓPRIA na
// planilha ("FITA GOMADA RITUÁRIA", coluna AA) a partir da semana 36/2026.
// Antes disso essa coluna não existia como fonte válida — o valor real
// ficava na coluna genérica de Fita Gomada, mesmo quando a coluna nova já
// existia com um "0" residual (não é dado real, é resíduo de planilha).
// Regra determinística, sem heurística de "vazio vs preenchido":
//   • antes da semana 36/2026 -> SEMPRE coluna genérica.
//   • a partir da semana 36/2026 -> SEMPRE coluna dedicada, incluindo 0
//     (zero é nível de estoque válido) — NUNCA cai para a genérica.
// O ano vem do timestamp (carimbo de data) de cada linha, não do "hoje" do
// sync, para não quebrar na virada do ano nem em reprocessamentos.
const RITUARIA_FITA_DEDICADA_DESDE={ano:2026,semana:36}
function rituariaUsaColunaDedicada(ano:number,semana:number):boolean{
  return ano>RITUARIA_FITA_DEDICADA_DESDE.ano
    ||(ano===RITUARIA_FITA_DEDICADA_DESDE.ano&&semana>=RITUARIA_FITA_DEDICADA_DESDE.semana)
}

const LEAD_TIMES:Record<string,number>={
  'Caixa PP':12,'Caixa P':7,'Caixa M':7,'Caixa G':9,'Caixa GG':9,
  'Fita Gomada':16,'FillPack':7.5,'Papel Colmeia':7.5,
}
const leadTimeDe=(insumo:string)=>LEAD_TIMES[insumo]??8
// SANITIZADO PARA PORTFÓLIO: URL original apontava para uma planilha interna da empresa.
// Configure via variável de ambiente SHEET_URL no seu próprio deploy (Google Sheets publicado como CSV).
const SHEET_URL=(globalThis as any).__ENV_SHEET_URL__ || 'https://docs.google.com/spreadsheets/d/SEU_SHEET_ID_AQUI/export?format=csv&gid=0'
const MARCA_NORMALIZE:Record<string,string>={
  'BB':'BB','AP':'AP','LE':'LE','LSC':'LE','KO':'KOKESHI','KOKESHI':'KOKESHI',
  'RITUARIA':'RITUÁRIA','RT':'RITUÁRIA','RITUÁRIA':'RITUÁRIA',
  'Gobeaute (AUÁ, BS e LSC)':'LE','Gobeaute (AUÁ, BS , LSC, KOKESHI E RITUARIA)':'LE',
  'Gobeaute (AUÁ, BS , LSC, KOKESHI)':'LE',
  'Lescent':'LE','LESCENT':'LE','lescent':'LE','LSC ES':'LE',
  // AUA e BY SAMIA são marcas próprias do grupo Lescent. Deixaram de ser
  // convertidas em LE: a consolidação delas acontece só na camada fiscal.
  // Registros históricos gravados como LE permanecem como LE — a separação
  // retroativa não é inventada (ver IDENTIDADE_HISTORICA_AGREGADA).
  'AUA':'AUA','AUÁ':'AUA','AUA ':'AUA',
  'By Samia':'BY SAMIA','BY SAMIA':'BY SAMIA','BY SAMIA ':'BY SAMIA','By Samia ':'BY SAMIA',
  'Gobeauté (AUÁ, BS e LSC)':'LE','Gobeauté (AUÁ, BS , LSC, KOKESHI)':'LE',
  'Gobeaute':'LE','GOBEAUTE':'LE','Gobeauté':'LE',
  'Gobeaute (AUÁ, BS , LSC, KOKESHI E RITUÁRIA)':'LE',
  'LE (Lescent, By Samia e AUA)':'LE',
  'LE (Lescent, By Samia e AUÁ)':'LE',
}
const normMarca=(m:string)=>MARCA_NORMALIZE[m.trim()]??m.trim()
const KRAFT_COEF=0.00633

// ── Pools físicos por CD ──────────────────────────────────────────────────────
// O estoque físico é compartilhado dentro do CD. O consumo continua sendo
// calculado marca a marca (rastreabilidade), mas estoque, cobertura, alerta,
// estoque-alvo e compra sugerida são avaliados UMA ÚNICA VEZ por pool.
//  • FillPack: um pool por CD. RITUÁRIA não usa mais FillPack -> fora do pool.
//  • Fita Gomada: AP+BB+KOKESHI+LE no ES e AP+BB no RJ. A fita da RITUÁRIA é
//    personalizada -> pool isolado, nunca somada às demais.
//  • Caixas: um pool por CD + tamanho, somando todas as marcas do CD.
// Status operacionais de uma entrada em trânsito. A troca é MANUAL: o sistema
// pode sugerir, nunca decide sozinho.
//   EM_TRANSITO      comprado, ainda não confirmado no CD. Entrada confiável.
//   PREVISAO_VENCIDA prazo passou sem confirmação. NÃO é entrada confiável:
//                    não protege cobertura nem reduz a compra sugerida.
//   RECEBIDO         chegou. Sai do trânsito e entra no estoque estimado,
//                    apenas se o recebimento for POSTERIOR ao snapshot usado
//                    (senão o snapshot físico já o incorpora).
const STATUS_TRANSITO=['EM_TRANSITO','PREVISAO_VENCIDA','RECEBIDO'] as const
const STATUS_CONFIAVEL=['EM_TRANSITO']

// Tipos de movimentação. A transferência tem DOIS efeitos: baixa imediata na
// origem (na data de saída) e entrada no destino apenas quando RECEBIDO.
// A baixa na origem NUNCA é revertida por previsão vencida — o material já saiu.
const TIPOS_MOVIMENTACAO=['COMPRA_FORNECEDOR','TRANSFERENCIA_CD'] as const

const MARCAS_ES=['AP','BB','KOKESHI','LE','RITUÁRIA']
// Marcas cujo histórico foi gravado sob outro código antes da separação de
// identidade. Não se inventa a divisão retroativa; apenas se sinaliza.
const IDENTIDADE_AGREGADA:Record<string,string>={
  'LE':'IDENTIDADE_HISTORICA_AGREGADA: registros anteriores a 25/08/2026 podem conter AUA e BY SAMIA gravados como LE. A separação retroativa não foi inferida.',
}
const MARCAS_RJ=['AP','BB']
// ── Fonte oficial de CDs válidos (v68) ──────────────────────────────────────
// Único ponto de verdade para o conjunto de CDs reconhecidos pelo Hub.
// NÃO é whitelist restritiva: nenhum endpoint rejeita um CD fora desta lista
// (transito, snapshot, transferencias aceitam qualquer string — o pool e a
// tabela de estoque minimo é que decidem se há dado real). Serve para o
// frontend renderizar os mesmos 4 CDs em todos os seletores, e para o
// endpoint /api/config/cds abaixo.
const CDS_OFICIAIS=['ES','RJ','SP','MG'] as const
// RITUÁRIA excluída operacionalmente do FillPack (decisão vigente).
const MARCAS_FILLPACK_ES=['AP','BB','KOKESHI','LE']
type Pool={insumo:string;cd:string;chave:string;label:string;marcas:string[];unidade:string}
const POOLS:Pool[]=[
  {insumo:'FillPack',cd:'ES',chave:'FILLPACK_ES',label:'POOL FILLPACK ES',
   marcas:MARCAS_FILLPACK_ES,unidade:'BOBINA'},
  {insumo:'FillPack',cd:'RJ',chave:'FILLPACK_RJ',label:'POOL FILLPACK RJ',
   marcas:MARCAS_RJ,unidade:'BOBINA'},
  {insumo:'Fita Gomada',cd:'ES',chave:'FITA_ES',label:'POOL FITA COMPARTILHADA ES',
   marcas:['AP','BB','KOKESHI','LE'],unidade:'BOBINA'},
  {insumo:'Fita Gomada',cd:'ES',chave:'FITA_RITUARIA_ES',label:'FITA RITUÁRIA (personalizada)',
   marcas:['RITUÁRIA'],unidade:'BOBINA'},
  {insumo:'Fita Gomada',cd:'RJ',chave:'FITA_RJ',label:'POOL FITA COMPARTILHADA RJ',
   marcas:MARCAS_RJ,unidade:'BOBINA'},
]
// Pools de caixas: CD + tamanho (mix continua individual por marca).
for(const t of ['Caixa PP','Caixa P','Caixa M','Caixa G','Caixa GG']){
  const sigla=t.replace('Caixa ','')
  POOLS.push({insumo:t,cd:'ES',chave:`CAIXA_${sigla}_ES`,label:`POOL ${t.toUpperCase()} · ES`,marcas:MARCAS_ES,unidade:'UN'})
  POOLS.push({insumo:t,cd:'RJ',chave:`CAIXA_${sigla}_RJ`,label:`POOL ${t.toUpperCase()} · RJ`,marcas:MARCAS_RJ,unidade:'UN'})
}
// Marcas que não utilizam determinado insumo no planejamento vigente.
// O fator histórico permanece no banco, mas não gera necessidade.
const INSUMO_DESCONTINUADO:{marca:string;insumo:string;motivo:string}[]=[
  {marca:'RITUÁRIA',insumo:'FillPack',motivo:'RITUÁRIA não utiliza mais FillPack. Fator histórico preservado no banco, fora do planejamento vigente.'},
]

// Mix CD — seed inicial (% lido do banco, nunca hardcoded na fórmula)
const SEED_MIX_CD=[
  {marca:'BB',      cd:'ES',pct_cd:0.90},
  {marca:'BB',      cd:'RJ',pct_cd:0.10},
  {marca:'AP',      cd:'ES',pct_cd:0.90},
  {marca:'AP',      cd:'RJ',pct_cd:0.10},
  {marca:'LE',      cd:'ES',pct_cd:1.00},
  {marca:'KOKESHI', cd:'ES',pct_cd:1.00},
  {marca:'RITUÁRIA',cd:'ES',pct_cd:1.00},
]

// ── Fatores de consumo (fonte: "4. Fatores de Consumo.csv") ──────────────────
// Fita Gomada em BOBINA/pedido (usar direto, NÃO reconverter de kg).
// FillPack TAMBÉM em BOBINA/pedido — o coeficiente já é bobina/pedido.
// Não existe conversão kg->bobina no planejamento do FillPack.
// AUA e BY SAMIA propositalmente AUSENTES: não há fator aprovado.
// Não herdar fator de LE/KOKESHI para elas.
// coef NULL + status NAO_DEFINIDO = fator inexistente, NUNCA inferido.
const SEED_FATORES_CONSUMO=[
  {marca:'BB',      cd:'ES',insumo:'Fita Gomada',coef:0.004052,un:'bob/ped',lt:16},
  {marca:'BB',      cd:'RJ',insumo:'Fita Gomada',coef:0.004052,un:'bob/ped',lt:16},
  {marca:'AP',      cd:'ES',insumo:'Fita Gomada',coef:0.003832,un:'bob/ped',lt:16},
  {marca:'AP',      cd:'RJ',insumo:'Fita Gomada',coef:0.003832,un:'bob/ped',lt:16},
  {marca:'LE',      cd:'ES',insumo:'Fita Gomada',coef:0.002339,un:'bob/ped',lt:16},
  {marca:'KOKESHI', cd:'ES',insumo:'Fita Gomada',coef:0.002339,un:'bob/ped',lt:16},
  {marca:'RITUÁRIA',cd:'ES',insumo:'Fita Gomada',coef:0.001583,un:'bob/ped',lt:16},
  {marca:'AUA',     cd:'ES',insumo:'Fita Gomada',coef:null,un:'bob/ped',lt:null},
  {marca:'BY SAMIA',cd:'ES',insumo:'Fita Gomada',coef:null,un:'bob/ped',lt:null},
  {marca:'BB',      cd:'ES',insumo:'FillPack',coef:0.002218,un:'bob/ped',lt:7.5},
  {marca:'BB',      cd:'RJ',insumo:'FillPack',coef:0.002218,un:'bob/ped',lt:7.5},
  {marca:'AP',      cd:'ES',insumo:'FillPack',coef:0.002765,un:'bob/ped',lt:7.5},
  {marca:'AP',      cd:'RJ',insumo:'FillPack',coef:0.002765,un:'bob/ped',lt:7.5},
  {marca:'LE',      cd:'ES',insumo:'FillPack',coef:0.001237,un:'bob/ped',lt:7.5},
  {marca:'KOKESHI', cd:'ES',insumo:'FillPack',coef:0.001237,un:'bob/ped',lt:7.5},
  {marca:'RITUÁRIA',cd:'ES',insumo:'FillPack',coef:0.001237,un:'bob/ped',lt:7.5},
  {marca:'AUA',     cd:'ES',insumo:'FillPack',coef:null,un:'bob/ped',lt:null},
  {marca:'BY SAMIA',cd:'ES',insumo:'FillPack',coef:null,un:'bob/ped',lt:null},
]

// ── Mix Final de caixas (fonte: "PAINEL DE MIX — DISTRIBUIÇÃO POR TAMANHO
// DE CAIXA | ATUALIZADO 2026"). NÃO usar a tabela inferior de referência.
const SEED_MIX_CAIXAS=[
  {marca:'AP',      cd:'ES',pp:0.15,p:0.00,m:0.40,g:0.45,gg:0.00,pct_cd:0.9},
  {marca:'AP',      cd:'RJ',pp:0.15,p:0.00,m:0.40,g:0.45,gg:0.00,pct_cd:0.1},
  {marca:'BB',      cd:'ES',pp:0.14,p:0.33,m:0.45,g:0.07,gg:0.01,pct_cd:0.9},
  {marca:'BB',      cd:'RJ',pp:0.14,p:0.33,m:0.45,g:0.07,gg:0.01,pct_cd:0.1},
  {marca:'LE',      cd:'ES',pp:0.26,p:0.43,m:0.30,g:0.01,gg:0.00,pct_cd:1},
  {marca:'KOKESHI', cd:'ES',pp:0.26,p:0.43,m:0.30,g:0.01,gg:0.00,pct_cd:1},
  {marca:'RITUÁRIA',cd:'ES',pp:0.38,p:0.40,m:0.11,g:0.11,gg:0.00,pct_cd:1},
  {marca:'AUA',     cd:'ES',pp:0.26,p:0.43,m:0.30,g:0.01,gg:0.00,pct_cd:1},
  {marca:'BY SAMIA',cd:'ES',pp:0.26,p:0.43,m:0.30,g:0.01,gg:0.00,pct_cd:1},
]
const TAMANHOS=[
  {col:'pp',insumo:'Caixa PP'},{col:'p',insumo:'Caixa P'},{col:'m',insumo:'Caixa M'},
  {col:'g',insumo:'Caixa G'},{col:'gg',insumo:'Caixa GG'},
]

const SEED_CONSUMO=[
  {marca:'BB',cd:'ES',insumo:'Caixa PP',consumo_mes:24252,unidade:'UN'},
  {marca:'BB',cd:'ES',insumo:'Caixa P',consumo_mes:57166,unidade:'UN'},
  {marca:'BB',cd:'ES',insumo:'Caixa M',consumo_mes:77954,unidade:'UN'},
  {marca:'BB',cd:'ES',insumo:'Caixa G',consumo_mes:12126,unidade:'UN'},
  {marca:'BB',cd:'ES',insumo:'Caixa GG',consumo_mes:1732,unidade:'UN'},
  {marca:'BB',cd:'ES',insumo:'Fita Gomada',consumo_mes:702,unidade:'BOBINA'},
  {marca:'BB',cd:'ES',insumo:'FillPack',consumo_mes:374,unidade:'BOBINA'},
  {marca:'BB',cd:'RJ',insumo:'Caixa PP',consumo_mes:2692,unidade:'UN'},
  {marca:'BB',cd:'RJ',insumo:'Caixa P',consumo_mes:6345,unidade:'UN'},
  {marca:'BB',cd:'RJ',insumo:'Caixa M',consumo_mes:8652,unidade:'UN'},
  {marca:'BB',cd:'RJ',insumo:'Caixa G',consumo_mes:1346,unidade:'UN'},
  {marca:'BB',cd:'RJ',insumo:'Caixa GG',consumo_mes:192,unidade:'UN'},
  {marca:'BB',cd:'RJ',insumo:'Fita Gomada',consumo_mes:78,unidade:'BOBINA'},
  {marca:'BB',cd:'RJ',insumo:'FillPack',consumo_mes:71,unidade:'BOBINA'},
  {marca:'AP',cd:'ES',insumo:'Caixa PP',consumo_mes:14074,unidade:'UN'},
  {marca:'AP',cd:'ES',insumo:'Caixa M',consumo_mes:37530,unidade:'UN'},
  {marca:'AP',cd:'ES',insumo:'Caixa G',consumo_mes:42222,unidade:'UN'},
  {marca:'AP',cd:'ES',insumo:'Fita Gomada',consumo_mes:360,unidade:'BOBINA'},
  {marca:'AP',cd:'ES',insumo:'FillPack',consumo_mes:290,unidade:'BOBINA'},
  {marca:'AP',cd:'RJ',insumo:'Caixa PP',consumo_mes:1740,unidade:'UN'},
  {marca:'AP',cd:'RJ',insumo:'Caixa M',consumo_mes:4639,unidade:'UN'},
  {marca:'AP',cd:'RJ',insumo:'Caixa G',consumo_mes:5219,unidade:'UN'},
  {marca:'AP',cd:'RJ',insumo:'Fita Gomada',consumo_mes:45,unidade:'BOBINA'},
  {marca:'AP',cd:'RJ',insumo:'FillPack',consumo_mes:55,unidade:'BOBINA'},
  {marca:'LE',cd:'ES',insumo:'Caixa PP',consumo_mes:19102,unidade:'UN'},
  {marca:'LE',cd:'ES',insumo:'Caixa P',consumo_mes:31593,unidade:'UN'},
  {marca:'LE',cd:'ES',insumo:'Caixa M',consumo_mes:22041,unidade:'UN'},
  {marca:'LE',cd:'ES',insumo:'Caixa G',consumo_mes:735,unidade:'UN'},
  {marca:'LE',cd:'ES',insumo:'Fita Gomada',consumo_mes:172,unidade:'BOBINA'},
  {marca:'LE',cd:'ES',insumo:'FillPack',consumo_mes:287,unidade:'BOBINA'},
  {marca:'KOKESHI',cd:'ES',insumo:'Caixa PP',consumo_mes:51259,unidade:'UN'},
  {marca:'KOKESHI',cd:'ES',insumo:'Caixa P',consumo_mes:84775,unidade:'UN'},
  {marca:'KOKESHI',cd:'ES',insumo:'Caixa M',consumo_mes:59145,unidade:'UN'},
  {marca:'KOKESHI',cd:'ES',insumo:'Caixa G',consumo_mes:1972,unidade:'UN'},
  {marca:'KOKESHI',cd:'ES',insumo:'Fita Gomada',consumo_mes:461,unidade:'BOBINA'},
  {marca:'KOKESHI',cd:'ES',insumo:'FillPack',consumo_mes:588,unidade:'BOBINA'},
  {marca:'RITUÁRIA',cd:'ES',insumo:'Caixa PP',consumo_mes:42725,unidade:'UN'},
  {marca:'RITUÁRIA',cd:'ES',insumo:'Caixa P',consumo_mes:44974,unidade:'UN'},
  {marca:'RITUÁRIA',cd:'ES',insumo:'Caixa M',consumo_mes:12368,unidade:'UN'},
  {marca:'RITUÁRIA',cd:'ES',insumo:'Caixa G',consumo_mes:12368,unidade:'UN'},
  {marca:'RITUÁRIA',cd:'ES',insumo:'Fita Gomada',consumo_mes:178,unidade:'BOBINA'},
  {marca:'RITUÁRIA',cd:'ES',insumo:'FillPack',consumo_mes:593,unidade:'BOBINA'},
]
const KRAFT_FILLPACK_V2=[
  {marca:'BB',cd:'ES',consumo_mes:374},{marca:'BB',cd:'RJ',consumo_mes:71},
  {marca:'AP',cd:'ES',consumo_mes:290},{marca:'AP',cd:'RJ',consumo_mes:55},
  {marca:'LE',cd:'ES',consumo_mes:287},{marca:'KOKESHI',cd:'ES',consumo_mes:588},
  {marca:'RITUÁRIA',cd:'ES',consumo_mes:593},
]
const SEED_PARAMS=[
  {chave:'lead_Caixa PP',valor:12,descricao:'Lead time Caixa PP (dias)'},
  {chave:'lead_Caixa P',valor:7,descricao:'Lead time Caixa P (dias)'},
  {chave:'lead_Caixa M',valor:7,descricao:'Lead time Caixa M (dias)'},
  {chave:'lead_Caixa G',valor:9,descricao:'Lead time Caixa G (dias)'},
  {chave:'lead_Caixa GG',valor:9,descricao:'Lead time Caixa GG (dias)'},
  {chave:'lead_Fita Gomada',valor:16,descricao:'Lead time Fita Gomada (dias)'},
  {chave:'lead_FillPack',valor:7.5,descricao:'Lead time FillPack (dias)'},
  {chave:'fator_seguranca',valor:0.5,descricao:'Buffer de segurança sobre o lead time'},
  {chave:'alerta_fator',valor:1.3,descricao:'Threshold de alerta (1.3 = 130%)'},
  {chave:'meta_reposicao',valor:2,descricao:'Meta de reposição em meses'},
  {chave:'fita_kg_por_bobina',valor:1.37,descricao:'Peso por bobina de fita gomada (kg)'},
]
// Cenário alternativo: meta de reposição calibrada por insumo.
// Itens de giro alto e reposição rápida com o fornecedor do ES carregam menos
// estoque; itens de lead time longo, baratos ou de fornecedor distante carregam
// mais. Editável na tela de Parâmetros (chaves meta_<insumo>).
const SEED_META_INSUMO:Record<string,number>={
  'Caixa PP':1.5,'Caixa P':1,'Caixa M':1,'Caixa G':1.5,'Caixa GG':1.5,
  'Fita Gomada':2,'FillPack':2,
}

// ── Camada fiscal: entidades de faturamento ──────────────────────────────────
// CNPJ da EMPRESA QUE RECEBE A NOTA — não confundir com fornecedores.cnpj,
// que é o CNPJ de quem emite. São coisas distintas e não se cruzam.
// cnpj_informado preserva exatamente o que foi fornecido; cnpj é a
// normalização, aplicada só depois de validar os dígitos verificadores.
const SEED_ENTIDADES_FATURAMENTO=[
  {codigo:'LESCENT_VAREJO_ES',   razao:'Lescent Varejo ES',    informado:'57.344.563.000.203'},
  {codigo:'BEAUTY_HUB_VAREJO_ES',razao:'Beauty Hub Varejo ES', informado:'60.453.162.000.107'},
  {codigo:'BEAUTY_HUB_VAREJO_RJ',razao:'Beauty Hub Varejo RJ', informado:'60.453.162.000.379'},
  {codigo:'AP_COSMETICS_ES',     razao:'AP COSMETICS ES',      informado:'48.290.289/0001-57'},
  {codigo:'AP_COSMETICS_RJ',     razao:'AP COSMETICS RJ',      informado:'48.290.289/0002-38'},
]

// Regras parametrizadas. Prioridade maior vence; marca+CD (100) prevalece
// sobre marca genérica (50). Nada disso é hardcoded no exportador.
const SEED_REGRAS_FATURAMENTO=[
  {marca:'LE',      cd:null, ent:'LESCENT_VAREJO_ES',    pri:50, obs:'Grupo Lescent'},
  {marca:'AUA',     cd:null, ent:'LESCENT_VAREJO_ES',    pri:50, obs:'Grupo Lescent'},
  {marca:'BY SAMIA',cd:null, ent:'LESCENT_VAREJO_ES',    pri:50, obs:'Grupo Lescent'},
  {marca:'KOKESHI', cd:null, ent:'BEAUTY_HUB_VAREJO_ES', pri:50, obs:'Grupo Beauty Hub'},
  {marca:'BB',      cd:null, ent:'BEAUTY_HUB_VAREJO_ES', pri:50, obs:'Grupo Beauty Hub (Barbour\'s)'},
  {marca:'RITUÁRIA',cd:null, ent:'BEAUTY_HUB_VAREJO_ES', pri:50, obs:'Grupo Beauty Hub'},
  {marca:'AP',      cd:'ES', ent:'AP_COSMETICS_ES',      pri:100,obs:'AP/Ápice depende do CD'},
  {marca:'AP',      cd:'RJ', ent:'AP_COSMETICS_RJ',      pri:100,obs:'AP/Ápice depende do CD'},
  // No CD RJ operam apenas AP e Beauty Hub. BB é a representação da operação
  // Beauty Hub no RJ — nenhuma marca foi criada artificialmente para isso.
  {marca:'BB',      cd:'RJ', ent:'BEAUTY_HUB_VAREJO_RJ', pri:100,obs:'Operação Beauty Hub no RJ'},
]

// Validação oficial de CNPJ. Nenhum dígito é corrigido: número que não passa
// fica registrado como CNPJ_PENDENTE_VALIDACAO com o valor original intacto.
function validarCNPJ(informado:string){
  const d=String(informado||'').replace(/\D/g,'')
  if(d.length!==14||/^(\d)\1{13}$/.test(d))
    return{digitos:d,normalizado:null,valido:false,status:'CNPJ_PENDENTE_VALIDACAO',
      motivo:d.length!==14?`Esperados 14 dígitos, encontrados ${d.length}`:'Sequência repetida'}
  const calc=(len:number)=>{
    let p=len-7,soma=0
    for(let i=0;i<len;i++){soma+=Number(d[i])*p--;if(p<2)p=9}
    const r=soma%11
    return r<2?0:11-r
  }
  const d1=calc(12),d2=calc(13)
  const ok=d1===Number(d[12])&&d2===Number(d[13])
  const fmt=`${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12)}`
  return{digitos:d,normalizado:ok?fmt:null,valido:ok,
    status:ok?'VALIDADO':'CNPJ_PENDENTE_VALIDACAO',
    dv_calculado:`${d1}${d2}`,dv_informado:d.slice(12),
    motivo:ok?null:'Dígitos verificadores não conferem — nenhum dígito foi alterado'}
}

const SEED_FORNECEDORES=[
  {nome:'PB EMBALAGENS LTDA',cnpj:'42.306.677/0001-00',contato:'27 99949-5568 (Júnior)',insumo:'Caixa PP',valor_un:0.55,unidade:'UN',uf:'ES',canal:'B2C',tipo:'PRINCIPAL'},
  {nome:'PB EMBALAGENS LTDA',cnpj:'42.306.677/0001-00',contato:'27 99949-5568 (Júnior)',insumo:'Caixa P',valor_un:0.82,unidade:'UN',uf:'ES',canal:'B2C',tipo:'PRINCIPAL'},
  {nome:'PB EMBALAGENS LTDA',cnpj:'42.306.677/0001-00',contato:'27 99949-5568 (Júnior)',insumo:'Caixa M',valor_un:0.98,unidade:'UN',uf:'ES',canal:'B2C',tipo:'PRINCIPAL'},
  {nome:'PB EMBALAGENS LTDA',cnpj:'42.306.677/0001-00',contato:'27 99949-5568 (Júnior)',insumo:'Caixa G',valor_un:1.55,unidade:'UN',uf:'ES',canal:'B2C',tipo:'PRINCIPAL'},
  {nome:'PB EMBALAGENS LTDA',cnpj:'42.306.677/0001-00',contato:'27 99949-5568 (Júnior)',insumo:'Caixa GG',valor_un:3.84,unidade:'UN',uf:'ES',canal:'B2C',tipo:'PRINCIPAL'},
  {nome:'FARO EMBALAGENS',cnpj:'22.502.970/0001-28',contato:'11 97216-2454 (Fábio)',insumo:'Caixa PP',valor_un:0.55,unidade:'UN',uf:'SP',canal:'B2C/MKTPLACE',tipo:'SECUNDÁRIO'},
  {nome:'FARO EMBALAGENS',cnpj:'22.502.970/0001-28',contato:'11 97216-2454 (Fábio)',insumo:'Caixa P',valor_un:0.79,unidade:'UN',uf:'SP',canal:'B2C/MKTPLACE',tipo:'SECUNDÁRIO'},
  {nome:'FARO EMBALAGENS',cnpj:'22.502.970/0001-28',contato:'11 97216-2454 (Fábio)',insumo:'Caixa M',valor_un:0.86,unidade:'UN',uf:'SP',canal:'B2C/MKTPLACE',tipo:'SECUNDÁRIO'},
  {nome:'FARO EMBALAGENS',cnpj:'22.502.970/0001-28',contato:'11 97216-2454 (Fábio)',insumo:'Caixa G',valor_un:1.74,unidade:'UN',uf:'SP',canal:'B2C/MKTPLACE',tipo:'SECUNDÁRIO'},
  {nome:'FARO EMBALAGENS',cnpj:'22.502.970/0001-28',contato:'11 97216-2454 (Fábio)',insumo:'Caixa GG',valor_un:3.00,unidade:'UN',uf:'SP',canal:'B2C/MKTPLACE',tipo:'SECUNDÁRIO'},
  {nome:'JUND CAIXAS',cnpj:'51.023.602/0001-0',contato:'11 99737-7540 (Dário)',insumo:'Caixa PP',valor_un:0.48,unidade:'UN',uf:'SP',canal:'MKTPLACE',tipo:'MKTPLACE'},
  {nome:'CYKLOP DO BRASIL',cnpj:'56.993.512/0001-50',contato:'11 97544-0594 (Márcio)',insumo:'Fita Gomada',valor_un:12.40,unidade:'KG',uf:'SP',canal:'B2C',tipo:'PRINCIPAL'},
  {nome:'PETROFITAS',cnpj:'24.655.424/0001-52',contato:'27 99630-7089 (Gustavo)',insumo:'Fita Gomada',valor_un:19.50,unidade:'KG',uf:'ES',canal:'B2C',tipo:'EMERGÊNCIA'},
  {nome:'L.R.L. PASSOS EMBALAGENS',cnpj:'27.390.298/0001-40',contato:'27 3020-6427 (Leidi)',insumo:'Fita Gomada',valor_un:20.80,unidade:'KG',uf:'ES',canal:'B2C',tipo:'EMERGÊNCIA'},
  {nome:'MB PACK',cnpj:'38.183.842/0001-07',contato:'11 95307-8163 (Cynthia)',insumo:'Fita Gomada',valor_un:21.50,unidade:'KG',uf:'SP',canal:'B2C',tipo:'SECUNDÁRIO'},
  {nome:'UNIPAR / RANPAK',cnpj:'11.191.719/0001-73',contato:'41 9678-0518 (Miliane)',insumo:'FillPack',valor_un:25.58,unidade:'KG',uf:'PR',canal:'B2C',tipo:'PRINCIPAL',valor_bobina:245},
  {nome:'L.R.L. PASSOS EMBALAGENS',cnpj:'27.390.298/0001-40',contato:'27 3020-6427 (Leidi)',insumo:'FillPack',valor_un:15.70,unidade:'KG',uf:'ES',canal:'B2C',tipo:'SECUNDÁRIO'},
  {nome:'UNIPAR EMBALAGENS',cnpj:'11.191.719/0001-73',contato:'41 9678-0518 (Miliane)',insumo:'Papel Colmeia',valor_un:429.57,unidade:'UN',uf:'PR',canal:'B2C',tipo:'PRINCIPAL'},
  {nome:'L.R.L. PASSOS EMBALAGENS',cnpj:'27.390.298/0001-40',contato:'27 3020-6427 (Leidi)',insumo:'Plástico Bolha',valor_un:72.00,unidade:'UN',uf:'ES',canal:'B2C',tipo:'PRINCIPAL'},
  {nome:'PETROFITAS',cnpj:'24.655.424/0001-52',contato:'27 99630-7089 (Gustavo)',insumo:'Plástico Bolha',valor_un:80.00,unidade:'UN',uf:'ES',canal:'B2C',tipo:'EMERGÊNCIA'},
]
const WEEK27:Record<string,unknown>[]=[
  {marca:'BB',cd:'SP',canal:'MARKETPLACE',semana:27,mes:7,caixa_pp:148750,caixa_p:8330,caixa_m:28518,caixa_g:1000,caixa_gg:1000,envelope_p:28000,envelope_m:64000,fill_pack:1,papel_colmeia:1,fita_gomada:1,plastico_bolha:1},
  {marca:'BB',cd:'ES',canal:'B2C',semana:27,mes:7,caixa_pp:0,caixa_p:171500,caixa_m:73200,caixa_g:11710,caixa_gg:3159,envelope_p:0,envelope_m:0,fill_pack:249,papel_colmeia:300,fita_gomada:30,plastico_bolha:0},
  {marca:'BB',cd:'RJ',canal:'B2C',semana:27,mes:7,caixa_pp:2250,caixa_p:3520,caixa_m:4100,caixa_g:6375,caixa_gg:2836,envelope_p:0,envelope_m:0,fill_pack:92,papel_colmeia:153,fita_gomada:255,plastico_bolha:0},
  {marca:'AP',cd:'ES',canal:'B2C',semana:27,mes:7,caixa_pp:0,caixa_p:0,caixa_m:60000,caixa_g:9300,caixa_gg:0,envelope_p:0,envelope_m:0,fill_pack:40,papel_colmeia:670,fita_gomada:15,plastico_bolha:0},
  {marca:'AP',cd:'RJ',canal:'B2C',semana:27,mes:7,caixa_pp:0,caixa_p:0,caixa_m:0,caixa_g:12600,caixa_gg:1175,envelope_p:0,envelope_m:0,fill_pack:116,papel_colmeia:149,fita_gomada:0,plastico_bolha:0},
  {marca:'LE',cd:'ES',canal:'B2C',semana:27,mes:7,caixa_pp:0,caixa_p:0,caixa_m:5566,caixa_g:0,caixa_gg:0,envelope_p:0,envelope_m:0,fill_pack:240,papel_colmeia:0,fita_gomada:0,plastico_bolha:0},
  {marca:'KOKESHI',cd:'ES',canal:'B2C',semana:27,mes:7,caixa_pp:0,caixa_p:26950,caixa_m:21000,caixa_g:0,caixa_gg:0,envelope_p:0,envelope_m:0,fill_pack:128,papel_colmeia:0,fita_gomada:120,plastico_bolha:72},
  {marca:'RITUÁRIA',cd:'ES',canal:'B2C',semana:27,mes:7,caixa_pp:0,caixa_p:36750,caixa_m:21000,caixa_g:2200,caixa_gg:0,envelope_p:0,envelope_m:0,fill_pack:114,papel_colmeia:40,fita_gomada:435,plastico_bolha:0},
]
const WEEK27_TIMESTAMPS:Record<string,string>={
  'BB':'2026-07-03 18:52:51','AP':'2026-07-03 20:33:24',
  'LE':'2026-07-03 20:32:34','KOKESHI':'2026-07-03 20:27:43','RITUARIA':'2026-07-03 20:17:11',
}
const INSUMO_ALERT_FIELDS:Record<string,string>={
  caixa_pp:'Caixa PP',caixa_p:'Caixa P',caixa_m:'Caixa M',
  caixa_g:'Caixa G',caixa_gg:'Caixa GG',fita_gomada:'Fita Gomada',fill_pack:'FillPack',
}
// Campo da tabela submissions correspondente a cada insumo (estoque atual).
const INSUMO_TO_FIELD:Record<string,string>={
  'Caixa PP':'caixa_pp','Caixa P':'caixa_p','Caixa M':'caixa_m',
  'Caixa G':'caixa_g','Caixa GG':'caixa_gg','Fita Gomada':'fita_gomada','FillPack':'fill_pack',
}

function getISOWeek(d=new Date()):number{const dt=new Date(d);dt.setHours(0,0,0,0);dt.setDate(dt.getDate()+4-(dt.getDay()||7));const y=new Date(dt.getFullYear(),0,1);return Math.ceil((((dt.getTime()-y.getTime())/86400000)+1)/7)}
function fmt(n:number):string{return n.toLocaleString('pt-BR')}
function addDays(d:Date,days:number):Date{const r=new Date(d);r.setDate(r.getDate()+Math.round(days));return r}

function parseBRtoUTC(s:string):string{
  if(!s||!s.trim()) return new Date().toISOString().replace('T',' ').slice(0,19)
  const m=s.trim().match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/)
  if(!m) return new Date().toISOString().replace('T',' ').slice(0,19)
  const dt=new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]||'00'}-03:00`)
  return dt.toISOString().replace('T',' ').slice(0,19)
}
function csvLine(line:string):string[]{
  const f:string[]=[]; let cur='',inQ=false
  for(let i=0;i<line.length;i++){
    const c=line[i]
    if(c==='"'){if(inQ&&line[i+1]==='"'){cur+='"';i++}else inQ=!inQ}
    else if(c===','&&!inQ){f.push(cur.trim());cur=''}
    else cur+=c
  }
  f.push(cur.trim()); return f
}
function parseNum(s:string|undefined):number{
  if(!s||s.trim()===''||s==='-') return 0
  return parseFloat(s.trim().replace(/[^0-9.,\-]/g,'').replace(',','.'))||0
}
function parseCaixa(s:string|undefined):number{return Math.round(parseNum(s)*1000)}

async function initDb(db:DB){
  await db.exec('CREATE TABLE IF NOT EXISTS schema_version(v INTEGER PRIMARY KEY)',[])
  const vr=await db.query(`SELECT v FROM schema_version WHERE v=${SCHEMA_VERSION}`,[])
  if(!vr.rows.length){
    for(const t of ['submissions','fills_semana','alertas','estoque_minimo','seed_done','fornecedores'])
      await db.exec(`DROP TABLE IF EXISTS ${t}`,[])
    await db.exec(`INSERT OR REPLACE INTO schema_version(v) VALUES(${SCHEMA_VERSION})`,[])
  }

  await db.exec(`CREATE TABLE IF NOT EXISTS submissions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    semana INTEGER NOT NULL,mes INTEGER NOT NULL,
    marca TEXT NOT NULL,cd TEXT NOT NULL,canal TEXT DEFAULT 'B2C',
    caixa_pp REAL DEFAULT 0,caixa_p REAL DEFAULT 0,caixa_m REAL DEFAULT 0,
    caixa_g REAL DEFAULT 0,caixa_gg REAL DEFAULT 0,
    envelope_p REAL DEFAULT 0,envelope_m REAL DEFAULT 0,
    fill_pack REAL DEFAULT 0,papel_colmeia REAL DEFAULT 0,
    fita_gomada REAL DEFAULT 0,plastico_bolha REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(semana,mes,marca,cd,canal))`,[])

  await db.exec(`CREATE TABLE IF NOT EXISTS fills_semana(
    semana INTEGER NOT NULL,mes INTEGER NOT NULL,marca TEXT NOT NULL,filled_at TEXT,
    PRIMARY KEY(semana,mes,marca))`,[])

  await db.exec(`CREATE TABLE IF NOT EXISTS alertas(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,marca TEXT,cd TEXT,canal TEXT,insumo TEXT,
    mensagem TEXT NOT NULL,valor_atual REAL,valor_referencia REAL,
    lido INTEGER DEFAULT 0,acionado INTEGER DEFAULT 0,acionado_at TEXT,
    created_at TEXT DEFAULT (datetime('now')))`,[])

  await db.exec(`CREATE TABLE IF NOT EXISTS estoque_minimo(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marca TEXT NOT NULL,cd TEXT NOT NULL,insumo TEXT NOT NULL,
    est_min REAL NOT NULL,alerta_threshold REAL NOT NULL,
    UNIQUE(marca,cd,insumo))`,[])

  // ── v71: consumo_mensal/consumo_dia REAIS, persistidos junto do est_min ────
  // Aditivo — não remove nem recalcula nada existente. Objetivo único: a aba
  // "Est. Mínimo" deixa de back-calcular (e errar) o consumo/dia a partir do
  // est_min; passa a exibir o valor que de fato gerou aquele est_min, seja
  // qual for o caminho que escreveu a linha (Forecast/aplicar-estoque-minimo
  // OU o caminho legado recalcMinimums/consumo_mensal).
  const emCols=(await db.query('PRAGMA table_info(estoque_minimo)',[])).rows as any[]
  const temColEM=(n:string)=>emCols.some(c=>c.name===n)
  if(!temColEM('consumo_mensal')) await db.exec('ALTER TABLE estoque_minimo ADD COLUMN consumo_mensal REAL',[])
  if(!temColEM('consumo_dia')) await db.exec('ALTER TABLE estoque_minimo ADD COLUMN consumo_dia REAL',[])

  await db.exec(`CREATE TABLE IF NOT EXISTS consumo_mensal(
    marca TEXT NOT NULL,cd TEXT NOT NULL,insumo TEXT NOT NULL,
    consumo_mes REAL NOT NULL,unidade TEXT DEFAULT 'UN',
    UNIQUE(marca,cd,insumo))`,[])

  await db.exec(`CREATE TABLE IF NOT EXISTS parametros(
    chave TEXT PRIMARY KEY,valor REAL NOT NULL,descricao TEXT,
    updated_at TEXT DEFAULT (datetime('now')))`,[])

  await db.exec(`CREATE TABLE IF NOT EXISTS fornecedores(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,cnpj TEXT,contato TEXT,
    insumo TEXT NOT NULL,valor_un REAL,unidade TEXT,uf TEXT,canal TEXT,
    tipo TEXT DEFAULT 'PRINCIPAL',valor_bobina REAL DEFAULT NULL,
    UNIQUE(nome,insumo,uf))`,[])

  await db.exec(`CREATE TABLE IF NOT EXISTS seed_done(
    id INTEGER PRIMARY KEY,done INTEGER DEFAULT 0,snap27 INTEGER DEFAULT 0)`,[])

  // ── Forecast — verifica schema e recria se coluna 'ano' ausente ─────────
  // Deploy anterior criou tabela com schema incorreto; detecta e corrige
  const fcInfo=await db.query("PRAGMA table_info(forecast_mensal)",[]).catch(()=>({rows:[]}))
  const hasAno=(fcInfo.rows as any[]).some((r:any)=>r.name==='ano')
  if(!hasAno){
    await db.exec('DROP TABLE IF EXISTS forecast_mensal',[])
    await db.exec('DROP TABLE IF EXISTS mix_cd',[])
  }
  await db.exec(`CREATE TABLE IF NOT EXISTS forecast_mensal(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ano INTEGER NOT NULL,mes INTEGER NOT NULL,
    marca TEXT NOT NULL,canal TEXT NOT NULL DEFAULT 'B2C',
    forecast_pedidos REAL NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(ano,mes,marca,canal))`,[])

  // Mix de distribuição por CD — lido do banco na hora do cálculo
  await db.exec(`CREATE TABLE IF NOT EXISTS mix_cd(
    marca TEXT NOT NULL,cd TEXT NOT NULL,pct_cd REAL NOT NULL,
    PRIMARY KEY(marca,cd))`,[])

  // Seed mix_cd idempotente (INSERT OR IGNORE)
  const mixCnt=await db.query('SELECT COUNT(*) as n FROM mix_cd',[])
  if(!Number((mixCnt.rows[0] as any)?.n)){
    for(const m of SEED_MIX_CD)
      await db.exec('INSERT OR IGNORE INTO mix_cd(marca,cd,pct_cd) VALUES(?,?,?)',[m.marca,m.cd,m.pct_cd])
  }

  // ── Premissas de planejamento (aditivo, sem DROP) ────────────────────────
  await db.exec(`CREATE TABLE IF NOT EXISTS fatores_consumo(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marca TEXT NOT NULL,cd TEXT NOT NULL,insumo TEXT NOT NULL,
    coef_principal REAL,unidade_coef TEXT,
    coef_aux REAL,unidade_aux TEXT,
    lead_time_d REAL,
    fonte TEXT,status TEXT DEFAULT 'DEFINIDO',
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(marca,cd,insumo))`,[])

  await db.exec(`CREATE TABLE IF NOT EXISTS mix_caixas(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marca TEXT NOT NULL,cd TEXT NOT NULL,
    pp REAL NOT NULL,p REAL NOT NULL,m REAL NOT NULL,
    g REAL NOT NULL,gg REAL NOT NULL,
    pct_cd REAL,fonte TEXT DEFAULT 'Mix Final 2026',
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(marca,cd))`,[])

  const fcCnt=await db.query('SELECT COUNT(*) as n FROM fatores_consumo',[])
  if(!Number((fcCnt.rows[0] as any)?.n)){
    for(const f of SEED_FATORES_CONSUMO)
      await db.exec('INSERT OR IGNORE INTO fatores_consumo(marca,cd,insumo,coef_principal,unidade_coef,lead_time_d,fonte,status) VALUES(?,?,?,?,?,?,?,?)',
        [f.marca,f.cd,f.insumo,f.coef,f.un,f.lt,
         f.coef==null?'Fator de consumo não definido':'Histórico ES',
         f.coef==null?'NAO_DEFINIDO':'DEFINIDO'])
  }
  const mxCnt=await db.query('SELECT COUNT(*) as n FROM mix_caixas',[])
  if(!Number((mxCnt.rows[0] as any)?.n)){
    for(const m of SEED_MIX_CAIXAS)
      await db.exec('INSERT OR IGNORE INTO mix_caixas(marca,cd,pp,p,m,g,gg,pct_cd) VALUES(?,?,?,?,?,?,?,?)',
        [m.marca,m.cd,m.pp,m.p,m.m,m.g,m.gg,m.pct_cd])
  }

  // Parâmetro novo: premissa operacional explícita de embalagens por pedido.
  // INSERT OR IGNORE => nunca sobrescreve valor já ajustado pelo usuário.
  await db.exec('INSERT OR IGNORE INTO parametros(chave,valor,descricao) VALUES(?,?,?)',
    ['embalagens_por_pedido',1,'Embalagens principais por pedido. Premissa operacional — Demanda Caixa = Forecast x este valor x Mix'])

  // Meta de reposição POR INSUMO (cenário alternativo, aditivo).
  // meta_reposicao continua valendo 2 meses e não é alterada — estas chaves
  // alimentam apenas o segundo cenário exibido na Sugestão de Compra.
  // INSERT OR IGNORE: nunca sobrescreve ajuste feito pelo usuário na tela.
  for(const[insumo,meses] of Object.entries(SEED_META_INSUMO))
    await db.exec('INSERT OR IGNORE INTO parametros(chave,valor,descricao) VALUES(?,?,?)',
      [`meta_${insumo}`,meses,`Meta de reposição de ${insumo} (meses) — cenário meta por insumo`])

  // ── Estoque em trânsito (comprado, ainda não recebido no CD) ─────────────
  // Aditivo. Alimenta apenas a Sugestão de Compra — nunca o Status atual.
  await db.exec(`CREATE TABLE IF NOT EXISTS compras_em_transito(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cd TEXT NOT NULL,
    marca TEXT,
    pool TEXT,
    canal TEXT DEFAULT 'B2C',
    insumo TEXT NOT NULL,
    quantidade REAL NOT NULL,
    unidade TEXT DEFAULT 'UN',
    data_prevista TEXT,
    observacao TEXT,
    ativo INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')))`,[])

  // ── Camada fiscal (aditiva) ──────────────────────────────────────────────
  // Posterior ao motor: recebe a necessidade já calculada e apenas a classifica.
  await db.exec(`CREATE TABLE IF NOT EXISTS entidades_faturamento(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT NOT NULL UNIQUE,
    razao_social TEXT NOT NULL,
    cnpj_informado TEXT NOT NULL,
    cnpj TEXT,
    cnpj_status TEXT NOT NULL DEFAULT 'CNPJ_PENDENTE_VALIDACAO',
    ativo INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')))`,[])

  await db.exec(`CREATE TABLE IF NOT EXISTS regras_faturamento(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marca_cod TEXT NOT NULL,
    cd_cod TEXT,
    entidade_faturamento_id INTEGER NOT NULL REFERENCES entidades_faturamento(id),
    prioridade INTEGER NOT NULL DEFAULT 50,
    ativo INTEGER NOT NULL DEFAULT 1,
    vigencia_inicio TEXT,
    vigencia_fim TEXT,
    observacao TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(marca_cod,cd_cod,entidade_faturamento_id))`,[])

  const entCnt=await db.query('SELECT COUNT(*) as n FROM entidades_faturamento',[])
  if(!Number((entCnt.rows[0] as any)?.n)){
    for(const e of SEED_ENTIDADES_FATURAMENTO){
      const v=validarCNPJ(e.informado)
      await db.exec('INSERT OR IGNORE INTO entidades_faturamento(codigo,razao_social,cnpj_informado,cnpj,cnpj_status) VALUES(?,?,?,?,?)',
        [e.codigo,e.razao,e.informado,v.normalizado,v.status])
    }
    for(const r of SEED_REGRAS_FATURAMENTO){
      const ent=await db.query('SELECT id FROM entidades_faturamento WHERE codigo=?',[r.ent])
      if(!ent.rows.length) continue
      await db.exec('INSERT OR IGNORE INTO regras_faturamento(marca_cod,cd_cod,entidade_faturamento_id,prioridade,observacao) VALUES(?,?,?,?,?)',
        [r.marca,r.cd,Number((ent.rows[0] as any).id),r.pri,r.obs])
    }
  }

  // ── Status operacional das entradas em trânsito (aditivo) ───────────────
  // Colunas adicionadas por ALTER TABLE para preservar os registros atuais.
  const trCols=(await db.query('PRAGMA table_info(compras_em_transito)',[])).rows as any[]
  const temCol=(n:string)=>trCols.some(c=>c.name===n)
  if(!temCol('status')) await db.exec("ALTER TABLE compras_em_transito ADD COLUMN status TEXT NOT NULL DEFAULT 'EM_TRANSITO'",[])
  if(!temCol('data_recebimento_real')) await db.exec('ALTER TABLE compras_em_transito ADD COLUMN data_recebimento_real TEXT',[])
  if(!temCol('quantidade_recebida')) await db.exec('ALTER TABLE compras_em_transito ADD COLUMN quantidade_recebida REAL',[])
  if(!temCol('pedido_oc')) await db.exec('ALTER TABLE compras_em_transito ADD COLUMN pedido_oc TEXT',[])
  // Transferência entre CDs: movimentação interna, não compra de fornecedor.
  // cd_origem só é preenchido em TRANSFERENCIA_CD; cd continua sendo o destino.
  if(!temCol('tipo_movimentacao')) await db.exec("ALTER TABLE compras_em_transito ADD COLUMN tipo_movimentacao TEXT NOT NULL DEFAULT 'COMPRA_FORNECEDOR'",[])
  if(!temCol('cd_origem')) await db.exec('ALTER TABLE compras_em_transito ADD COLUMN cd_origem TEXT',[])
  if(!temCol('data_saida')) await db.exec('ALTER TABLE compras_em_transito ADD COLUMN data_saida TEXT',[])
  // Marcador de apuração pendente. Não altera nenhum dado do registro.
  if(!temCol('apuracao')) await db.exec('ALTER TABLE compras_em_transito ADD COLUMN apuracao TEXT',[])

  // Histórico de alteração de status — nunca sobrescrito nem apagado.
  await db.exec(`CREATE TABLE IF NOT EXISTS transito_historico(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transito_id INTEGER NOT NULL REFERENCES compras_em_transito(id),
    status_anterior TEXT,status_novo TEXT NOT NULL,
    quantidade_recebida REAL,data_recebimento_real TEXT,
    autor TEXT,observacao TEXT,
    data_alteracao TEXT DEFAULT (datetime('now')))`,[])

  await migracoesV41(db)
  await migracaoLeadTimesOficiais(db)
  await migracaoRegraFiscalRJ(db)

  const sd=await db.query('SELECT done,snap27 FROM seed_done WHERE id=1',[])
  const row=sd.rows[0] as any

  if(!row?.done){
    for(const c of SEED_CONSUMO)
      await db.exec('INSERT OR IGNORE INTO consumo_mensal(marca,cd,insumo,consumo_mes,unidade) VALUES(?,?,?,?,?)',
        [c.marca,c.cd,c.insumo,c.consumo_mes,c.unidade])
    for(const p of SEED_PARAMS)
      await db.exec('INSERT OR IGNORE INTO parametros(chave,valor,descricao) VALUES(?,?,?)',
        [p.chave,p.valor,p.descricao])
    await recalcMinimums(db)
    for(const f of SEED_FORNECEDORES)
      await db.exec('INSERT OR IGNORE INTO fornecedores(nome,cnpj,contato,insumo,valor_un,unidade,uf,canal,tipo,valor_bobina) VALUES(?,?,?,?,?,?,?,?,?,?)',
        [f.nome,f.cnpj,f.contato,f.insumo,f.valor_un,f.unidade,f.uf,f.canal,(f as any).tipo||'PRINCIPAL',(f as any).valor_bobina??null])
    await db.exec('INSERT OR REPLACE INTO seed_done(id,done,snap27) VALUES(1,1,0)',[])
  }

  if(!row?.snap27){
    for(const snap of WEEK27){
      await db.exec(`INSERT OR IGNORE INTO submissions(semana,mes,marca,cd,canal,caixa_pp,caixa_p,caixa_m,caixa_g,caixa_gg,envelope_p,envelope_m,fill_pack,papel_colmeia,fita_gomada,plastico_bolha) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [snap.semana,snap.mes,snap.marca,snap.cd,snap.canal,snap.caixa_pp,snap.caixa_p,snap.caixa_m,snap.caixa_g,snap.caixa_gg,snap.envelope_p,snap.envelope_m,snap.fill_pack,snap.papel_colmeia,snap.fita_gomada,snap.plastico_bolha])
      await db.exec('INSERT OR IGNORE INTO fills_semana(semana,mes,marca,filled_at) VALUES(?,?,?,?)',
        [snap.semana,snap.mes,snap.marca,WEEK27_TIMESTAMPS[String(snap.marca)]||'2026-07-03 17:30:00'])
    }
    for(const snap of WEEK27){if(snap.canal!=='B2C') continue;await generateAlerts(db,snap)}
    for(const m of MARCAS_ESPERADAS)
      await db.exec("INSERT INTO alertas(tipo,marca,cd,canal,mensagem) VALUES('PREENCHIMENTO',?,'-','B2C',?)",
        [m,`${m} preencheu semana 27 (03/07/2026).`])
    try{const r=await syncSheet(db);console.log('Auto-sync:',r.synced,'rows')}catch(e){console.log('Auto-sync failed:',e)}
    await db.exec('UPDATE seed_done SET snap27=1 WHERE id=1',[])
  }
}

// ── Migração v41 (idempotente, roda uma única vez) ────────────────────────────
// 1) FillPack: coeficiente já é bobina/pedido -> corrige rótulo da unidade.
// 2) e 3) ajustavam lead times de Fita e caixas para 21 dias — valores
//    posteriormente substituídos pelos oficiais na migração v48.
// Nada de coeficiente/mix/forecast é tocado. fillpack_kg_por_bob e
// fita_kg_por_bobina permanecem no banco por histórico/custo.
async function migracoesV41(db:DB){
  await db.exec('CREATE TABLE IF NOT EXISTS migracoes(chave TEXT PRIMARY KEY,aplicada_em TEXT DEFAULT (datetime(\'now\')))',[])
  const done=await db.query("SELECT chave FROM migracoes WHERE chave='v41_fillpack_bobina_lead21'",[])
  if(done.rows.length) return
  await db.exec("UPDATE fatores_consumo SET unidade_coef='bob/ped',updated_at=datetime('now') WHERE insumo='FillPack'",[])
  await db.exec("UPDATE fatores_consumo SET lead_time_d=21,updated_at=datetime('now') WHERE insumo='Fita Gomada' AND lead_time_d IS NOT NULL",[])
  await db.exec("UPDATE parametros SET valor=21,updated_at=datetime('now') WHERE chave='lead_Fita Gomada'",[])
  for(const k of ['lead_Caixa PP','lead_Caixa P','lead_Caixa M','lead_Caixa G','lead_Caixa GG'])
    await db.exec("UPDATE parametros SET valor=21,updated_at=datetime('now') WHERE chave=?",[k])
  await db.exec("UPDATE consumo_mensal SET unidade='BOBINA' WHERE insumo='FillPack'",[])
  await db.exec("INSERT OR IGNORE INTO migracoes(chave) VALUES('v41_fillpack_bobina_lead21')",[])
  await recalcMinimums(db)
}

// ── Migração v48: lead times oficiais por insumo ──────────────────────────────
// Substitui o lead time genérico de 21 dias (caixas e Fita Gomada) pelos
// prazos reais de cada item. Idempotente; roda uma única vez.
// Nada além de lead_* e fatores_consumo.lead_time_d da Fita é tocado.
const LEAD_TIMES_OFICIAIS:Record<string,number>={
  'Caixa PP':12,'Caixa P':7,'Caixa M':7,'Caixa G':9,'Caixa GG':9,
  'Fita Gomada':16,'FillPack':7.5,
}
// ── Migração v56 — regra fiscal do CD RJ ─────────────────────────────────────
// No RJ operam apenas AP e Beauty Hub. A regra BB+RJ (prioridade 100) elimina
// a pendência que a regra genérica de marca gerava. Aditiva e idempotente.
async function migracaoRegraFiscalRJ(db:DB){
  const done=await db.query("SELECT chave FROM migracoes WHERE chave='v56_regra_fiscal_rj'",[])
  if(done.rows.length) return
  const ent=await db.query("SELECT id FROM entidades_faturamento WHERE codigo='BEAUTY_HUB_VAREJO_RJ'",[])
  if(ent.rows.length){
    await db.exec(`INSERT OR IGNORE INTO regras_faturamento(marca_cod,cd_cod,entidade_faturamento_id,prioridade,observacao)
      VALUES('BB','RJ',?,100,'Operação Beauty Hub no RJ')`,[Number((ent.rows[0] as any).id)])
  }
  await db.exec("INSERT OR IGNORE INTO migracoes(chave) VALUES('v56_regra_fiscal_rj')",[])
}

async function migracaoLeadTimesOficiais(db:DB){
  const done=await db.query("SELECT chave FROM migracoes WHERE chave='v48_lead_times_oficiais'",[])
  if(done.rows.length) return
  for(const[insumo,lt] of Object.entries(LEAD_TIMES_OFICIAIS))
    await db.exec("UPDATE parametros SET valor=?,updated_at=datetime('now') WHERE chave=?",[lt,`lead_${insumo}`])
  await db.exec("UPDATE fatores_consumo SET lead_time_d=16,updated_at=datetime('now') WHERE insumo='Fita Gomada' AND lead_time_d IS NOT NULL",[])
  await db.exec("INSERT OR IGNORE INTO migracoes(chave) VALUES('v48_lead_times_oficiais')",[])
  await recalcMinimums(db)
}

async function generateAlerts(db:DB,data:Record<string,unknown>){
  const{semana,mes,marca,cd,canal}=data as any
  const results:{tipo:string;insumo:string;mensagem:string;valor_atual:number;valor_referencia:number}[]=[],
  prevRes=await db.query('SELECT * FROM submissions WHERE marca=? AND cd=? AND canal=? AND semana<? ORDER BY semana DESC LIMIT 1',[marca,cd,canal,semana])
  const prev=prevRes.rows[0] as Record<string,unknown>|undefined
  const emRes=await db.query('SELECT insumo,est_min,alerta_threshold FROM estoque_minimo WHERE marca=? AND cd=?',[marca,cd])
  const emMap:Record<string,{est_min:number;alerta_threshold:number}>={};
  for(const r of emRes.rows as any[]) emMap[r.insumo]={est_min:r.est_min,alerta_threshold:r.alerta_threshold}
  for(const[field,insumo] of Object.entries(INSUMO_ALERT_FIELDS)){
    const cur=Number(data[field]??0)
    if(prev){
      const prv=Number(prev[field]??0)
      const wk=(emMap[insumo]?.est_min??0)/WEEKS_PER_MONTH
      if(prv>0&&cur>prv)
        results.push({tipo:'ENTRADA',insumo,mensagem:`Estoque aumentou ${fmt(cur-prv)} un (${fmt(prv)} → ${fmt(cur)}). Verificar entrada.`,valor_atual:cur,valor_referencia:prv})
      else if(prv>0&&wk>0&&(prv-cur)>wk*ANOMALIA_FACTOR)
        results.push({tipo:'SAIDA_ANORMAL',insumo,mensagem:`Saída acima do esperado: ${fmt(prv-cur)} vs projetado ${fmt(Math.round(wk))} un/sem.`,valor_atual:cur,valor_referencia:Math.round(wk)})
    }
    const em=emMap[insumo]
    if(em&&cur<=em.alerta_threshold){
      const pct=em.est_min>0?Math.round((cur/em.est_min)*100):0
      const status=cur<=em.est_min?'🔴 ABAIXO DO MÍNIMO':'🟡 Próximo do mínimo'
      results.push({tipo:'ESTOQUE_MINIMO',insumo,mensagem:`${status} — ${fmt(cur)} un (${pct}% do mínimo de ${fmt(em.est_min)}). Acionar pedido!`,valor_atual:cur,valor_referencia:em.est_min})
    }
  }
  for(const a of results){
    const dupe=await db.query("SELECT id FROM alertas WHERE tipo=? AND marca=? AND COALESCE(cd,'')=? AND COALESCE(insumo,'')=? AND created_at > datetime('now','-8 days')",
      [a.tipo,marca,cd||'',a.insumo||''])
    if(!dupe.rows.length)
      await db.exec('INSERT INTO alertas(tipo,marca,cd,canal,insumo,mensagem,valor_atual,valor_referencia) VALUES(?,?,?,?,?,?,?,?)',
        [a.tipo,marca,cd,canal??'B2C',a.insumo,a.mensagem,a.valor_atual,a.valor_referencia])
  }
  return results
}

async function recalcMinimums(db:DB){
  const pRes=await db.query('SELECT chave,valor FROM parametros',[])
  const P:Record<string,number>={}
  for(const r of pRes.rows as any[]) P[r.chave]=Number(r.valor)
  const fatorSeg=P['fator_seguranca']??0.5
  const alertaFator=P['alerta_fator']??1.3
  const consumoRes=await db.query('SELECT * FROM consumo_mensal',[])
  for(const c of consumoRes.rows as any[]){
    const lt=P[`lead_${c.insumo}`]??8
    const consumo_dia=Number(c.consumo_mes)/30.4
    const est_min=Math.max(1,Math.round(consumo_dia*lt*(1+fatorSeg)))
    const alerta_threshold=Math.round(est_min*alertaFator)
    await db.exec('INSERT OR REPLACE INTO estoque_minimo(marca,cd,insumo,est_min,alerta_threshold,consumo_mensal,consumo_dia) VALUES(?,?,?,?,?,?,?)',
      [c.marca,c.cd,c.insumo,est_min,alerta_threshold,Number(c.consumo_mes),r2(consumo_dia)])
  }
}

function enrichInsumo(field:string,label:string,current:number,md:{est_min:number;alerta_threshold:number}|undefined,today:Date){
  if(!md) return{field,label,current,status:'NA',pct:null,est_min:null,alerta_threshold:null,cobertura_dias:null,lead_time:null,cor_cobertura:'NA',sugestao_pedido:null,ruptura_em_dias:null,ruptura_data:null}
  const pct=md.est_min>0?Math.round((current/md.est_min)*100):0
  const status=current===0&&md.est_min>0?'CRITICAL':current<=md.est_min?'CRITICAL':current<=md.alerta_threshold?'WARNING':'OK'
  const consumo_dia=md.est_min/DIAS_MES
  const cobertura_dias=consumo_dia>0?Math.round(current/consumo_dia):null
  const lt=LEAD_TIMES[label]??8
  const cor_cobertura=cobertura_dias==null?'NA':cobertura_dias>lt*2?'OK':cobertura_dias>lt?'WARNING':'CRITICAL'
  const sugestao=(status==='CRITICAL'||status==='WARNING')?Math.max(0,Math.round(md.est_min*2-current)):null
  const ruptura_em_dias=cobertura_dias
  const ruptura_data=cobertura_dias!=null&&cobertura_dias<90?addDays(today,cobertura_dias).toISOString().slice(0,10):null
  return{field,label,current,est_min:md.est_min,alerta_threshold:md.alerta_threshold,pct,status,
    cobertura_dias,lead_time:lt,cor_cobertura,sugestao_pedido:sugestao,ruptura_em_dias,ruptura_data}
}

interface SheetRow{marca:string;cd:string;canal:string;semana:number;mes:number;timestamp:string;
  caixa_pp:number;caixa_p:number;caixa_m:number;caixa_g:number;caixa_gg:number;
  envelope_p:number;envelope_m:number;fill_pack:number;papel_colmeia:number;
  fita_gomada:number;plastico_bolha:number}

async function syncSheet(db:DB):Promise<{synced:number;semana:number;errors:string[]}>{
  const resp=await fetch(SHEET_URL)
  if(!resp.ok) throw new Error(`Sheet HTTP ${resp.status}`)
  const csv=await resp.text()
  const lines=csv.split('\n')
  if(lines.length<2) throw new Error('Empty sheet')
  const hdrs=csvLine(lines[0]).map(h=>(h||'').trim().toLowerCase())
  const get=(c:string[],idx:number):string=>idx>=0&&idx<c.length?(c[idx]||'').trim():''
  const ci=(...matches:string[])=>{for(const m of matches){const i=hdrs.findIndex(h=>h.includes(m));if(i>=0)return i}; return -1}
  const C={
    timestamp:ci('carimbo de data','carimbo','timestamp'),
    semana:ci('número_semana','numero_semana','n_semana','semana'),
    mes:ci('mês','mes'),marca:ci('marca'),cd:hdrs.indexOf('cd'),
    caixa_pp:hdrs.findIndex(h=>h.endsWith('caixa pp')||h==='caixa pp'),
    caixa_p:hdrs.findIndex(h=>(h.endsWith('caixa p')||h==='caixa p')&&!h.includes('pp')),
    caixa_m:hdrs.findIndex(h=>h.endsWith('caixa m')||h==='caixa m'),
    caixa_g:hdrs.findIndex(h=>(h.endsWith('caixa g')||h==='caixa g')&&!h.includes('gg')),
    caixa_gg:hdrs.findIndex(h=>h.endsWith('caixa gg')||h==='caixa gg'),
    envelope_p:ci('envelope p'),envelope_m:ci('envelope m'),
    fill_pack:ci('fill pack','fillpack'),colmeia:ci('papel colmeia','colmeia'),
    // Fita Gomada tem DUAS colunas na planilha: a genérica (AP/BB/LE/KOKESHI)
    // e a dedicada da RITUÁRIA (personalizada, coluna AA — "FITA GOMADA
    // RITUÁRIA"). Como esse nome também contém a substring "fita gomada",
    // ci() sempre resolvia para a coluna genérica e a RITUÁRIA gravava 0.
    // fitaGenerica exclui explicitamente a coluna com "rituária" para nunca
    // mais colidir com ela, não importa a ordem das colunas na planilha.
    fitaGenerica:hdrs.findIndex(h=>h.includes('fita gomada')&&!h.includes('rituária')&&!h.includes('rituaria')),
    fitaRituaria:hdrs.findIndex(h=>h.includes('fita')&&(h.includes('rituária')||h.includes('rituaria'))),
    bolha:ci('plástico bolha','plastico bolha','plástico bolha'),
    canal:ci('canal de operação','canal de operacao','canal'),
  }
  // Fallback de segurança: se por algum motivo a coluna genérica não for
  // encontrada (planilha reordenada de forma inesperada), volta ao
  // comportamento antigo em vez de não gravar nada.
  if(C.fitaGenerica<0) C.fitaGenerica=ci('fita gomada')
  if(C.cd<0) C.cd=ci('"cd"','cd')
  const parsed:SheetRow[]=[]
  for(let i=1;i<lines.length;i++){
    const ln=lines[i].trim();if(!ln) continue
    const c=csvLine(lines[i]);if(c.length<5) continue
    const marcaRaw=get(c,C.marca);if(!marcaRaw) continue
    const marca=normMarca(marcaRaw)
    if(marca===marcaRaw&&!MARCAS_ESPERADAS.includes(marca)&&!Object.values(MARCA_NORMALIZE).includes(marcaRaw)) continue
    const cd=get(c,C.cd)||'ES'
    const canalRaw=get(c,C.canal);const canal=canalRaw?canalRaw.toUpperCase():'B2C'
    const semana=parseInt(get(c,C.semana))||0;const mes=parseInt(get(c,C.mes))||0
    if(!semana||!mes) continue
    const timestamp=parseBRtoUTC(get(c,C.timestamp))
    // RITUÁRIA: fonte da Fita Gomada decidida por DATA (semana/ano da própria
    // linha), nunca por "a coluna está vazia?" — um "0" na coluna dedicada é
    // um valor real, não ausência de dado, e não pode empurrar a leitura de
    // volta pra genérica. Ver RITUARIA_FITA_DEDICADA_DESDE.
    const anoRow=parseInt(timestamp.slice(0,4))||new Date().getFullYear()
    let fitaRaw:string
    if(marca==='RITUÁRIA'&&rituariaUsaColunaDedicada(anoRow,semana)){
      fitaRaw=C.fitaRituaria>=0?get(c,C.fitaRituaria):''
    }else{
      fitaRaw=get(c,C.fitaGenerica)
    }
    parsed.push({marca,cd,canal,semana,mes,timestamp,
      caixa_pp:parseCaixa(get(c,C.caixa_pp)),caixa_p:parseCaixa(get(c,C.caixa_p)),
      caixa_m:parseCaixa(get(c,C.caixa_m)),caixa_g:parseCaixa(get(c,C.caixa_g)),
      caixa_gg:parseCaixa(get(c,C.caixa_gg)),
      envelope_p:Math.round(parseNum(get(c,C.envelope_p))),envelope_m:Math.round(parseNum(get(c,C.envelope_m))),
      fill_pack:Math.round(parseNum(get(c,C.fill_pack))),papel_colmeia:Math.round(parseNum(get(c,C.colmeia))),
      fita_gomada:Math.round(parseNum(fitaRaw)),plastico_bolha:Math.round(parseNum(get(c,C.bolha))),
    })
  }
  if(!parsed.length) return{synced:0,semana:0,errors:['No valid rows parsed']}
  const maxSemana=Math.max(...parsed.map(r=>r.semana))
  let synced=0
  for(const row of parsed){
    await db.exec(`INSERT OR IGNORE INTO submissions(semana,mes,marca,cd,canal,caixa_pp,caixa_p,caixa_m,caixa_g,caixa_gg,envelope_p,envelope_m,fill_pack,papel_colmeia,fita_gomada,plastico_bolha) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [row.semana,row.mes,row.marca,row.cd,row.canal,row.caixa_pp,row.caixa_p,row.caixa_m,row.caixa_g,row.caixa_gg,row.envelope_p,row.envelope_m,row.fill_pack,row.papel_colmeia,row.fita_gomada,row.plastico_bolha])
    await db.exec('INSERT OR IGNORE INTO fills_semana(semana,mes,marca,filled_at) VALUES(?,?,?,?)',[row.semana,row.mes,row.marca,row.timestamp])
    if(row.semana===maxSemana&&row.canal!=='MARKETPLACE') await generateAlerts(db,row as Record<string,unknown>)
    synced++
  }
  const latestTs=new Map<string,{ts:string;mes:number}>()
  for(const row of parsed){const key=`${row.marca}|${row.semana}`;const ex=latestTs.get(key);if(!ex||row.timestamp>ex.ts) latestTs.set(key,{ts:row.timestamp,mes:row.mes})}
  for(const[key,{ts,mes}] of latestTs){const[marca,semStr]=key.split('|');await db.exec('INSERT OR REPLACE INTO fills_semana(semana,mes,marca,filled_at) VALUES(?,?,?,?)',[parseInt(semStr),mes,marca,ts])}
  const fillsRes=await db.query('SELECT marca FROM fills_semana WHERE semana=?',[maxSemana])
  const filled=new Set((fillsRes.rows as any[]).map(r=>r.marca))
  for(const m of MARCAS_ESPERADAS){
    if(!filled.has(m)) continue
    const exists=await db.query("SELECT id FROM alertas WHERE tipo='PREENCHIMENTO' AND marca=? AND insumo=?",[m,`sem_${maxSemana}`])
    if(!exists.rows.length)
      await db.exec("INSERT INTO alertas(tipo,marca,cd,canal,mensagem,insumo) VALUES('PREENCHIMENTO',?,'-','B2C',?,?)",
        [m,`${m} preencheu semana ${maxSemana} (sync automático).`,`sem_${maxSemana}`])
  }
  return{synced,semana:maxSemana,errors:[]}
}

async function sendEmail(env:Env,subject:string,html:string){
  if(!env.RESEND_API_KEY||!env.ALERT_EMAIL) return
  const from=env.FROM_EMAIL||'Hub Insumos <onboarding@resend.dev>'
  try{const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Authorization':`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from,to:[env.ALERT_EMAIL],subject,html})});if(!r.ok) console.error('Resend:',await r.text())}catch(e){console.error('email:',e)}
}
async function sendChat(url:string,text:string){
  if(!url) return
  try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});if(!r.ok) console.error('GChat:',r.status)}catch(e){console.error('GChat:',e)}
}
const tplMissing=(m:string,s:number)=>`<div style="font-family:Arial;max-width:580px"><div style="background:#DC2626;padding:16px 20px;border-radius:8px 8px 0 0"><h2 style="margin:0;color:#fff">⚠️ ${m} não preencheu — Semana ${s}</h2></div><div style="background:#FEF2F2;border:1px solid #FECACA;padding:20px;border-radius:0 0 8px 8px"><p style="color:#7F1D1D">${m} ainda não preencheu o formulário da semana ${s}.</p></div></div>`
const tplFillOk=(m:string,cd:string,s:number,canal:string)=>`<div style="font-family:Arial;max-width:580px"><div style="background:#16A34A;padding:16px 20px;border-radius:8px 8px 0 0"><h2 style="margin:0;color:#fff">✅ ${m} ${cd} (${canal}) — Semana ${s}</h2></div><div style="background:#F0FDF4;border:1px solid #BBF7D0;padding:20px;border-radius:0 0 8px 8px"><p style="color:#14532D">${m} (${cd}·${canal}) preencheu a semana ${s}.</p></div></div>`
function tplAlerts(m:string,cd:string,canal:string,s:number,alerts:{tipo:string;insumo:string;mensagem:string}[]){
  const cm:Record<string,{bg:string;txt:string;badge:string}>={ENTRADA:{bg:'#FFFBEB',txt:'#78350F',badge:'#F59E0B'},SAIDA_ANORMAL:{bg:'#FFF7ED',txt:'#7C2D12',badge:'#EA580C'},ESTOQUE_MINIMO:{bg:'#FEF2F2',txt:'#7F1D1D',badge:'#DC2626'}}
  const rows=alerts.map(a=>{const c=cm[a.tipo]??{bg:'#F9FAFB',txt:'#111827',badge:'#6B7280'};const lbl=a.tipo==='ENTRADA'?'Entrada':a.tipo==='SAIDA_ANORMAL'?'Saída anormal':'Crítico';return`<tr style="background:${c.bg}"><td style="padding:8px 12px;border-bottom:1px solid #E5E7EB"><span style="background:${c.badge};color:#fff;font-size:11px;padding:2px 8px;border-radius:99px">${lbl}</span></td><td style="padding:8px 12px;border-bottom:1px solid #E5E7EB;color:${c.txt};font-weight:600">${a.insumo}</td><td style="padding:8px 12px;border-bottom:1px solid #E5E7EB;color:${c.txt}">${a.mensagem}</td></tr>`}).join('')
  return`<div style="font-family:Arial;max-width:680px"><div style="background:#1D4ED8;padding:16px 20px;border-radius:8px 8px 0 0"><h2 style="margin:0;color:#fff">🔔 ${alerts.length} Alerta(s) — ${m} ${cd} (${canal}) · Semana ${s}</h2></div><div style="background:#EFF6FF;border:1px solid #BFDBFE;padding:20px;border-radius:0 0 8px 8px"><table style="width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden"><thead><tr style="background:#1D4ED8;color:#fff"><th style="padding:8px 12px;text-align:left">Tipo</th><th style="padding:8px 12px;text-align:left">Insumo</th><th style="padding:8px 12px;text-align:left">Detalhe</th></tr></thead><tbody>${rows}</tbody></table></div></div>`
}

const app=new Hono<{Bindings:Env}>()
app.use('/api/*',cors({origin:'*'}))

app.get('/api/health',c=>c.json({ok:true,schema:SCHEMA_VERSION,ts:new Date().toISOString(),kraft_coef:KRAFT_COEF,fundacao:'fundacao-v1',versao:'v72'}))

// Fonte oficial de CDs para o frontend (fonte mestre única, v68).
app.get('/api/config/cds',c=>c.json({cds:CDS_OFICIAIS}))

app.get('/api/fundacao/status',async c=>{
  await initDb(c.env.DB)
  const [paramRes,insumoDistRes,mixRes,emRes]=await Promise.all([
    c.env.DB.query('SELECT COUNT(*) as n FROM parametros',[]),
    c.env.DB.query('SELECT COUNT(DISTINCT insumo) as n FROM consumo_mensal',[]),
    c.env.DB.query('SELECT COUNT(DISTINCT insumo) as n FROM fornecedores',[]),
    c.env.DB.query('SELECT COUNT(*) as total,SUM(CASE WHEN e.est_min>0 THEN 1 ELSE 0 END) as com_minimo FROM consumo_mensal cm LEFT JOIN estoque_minimo e ON cm.marca=e.marca AND cm.cd=e.cd AND cm.insumo=e.insumo',[]),
  ])
  const fatores_consumo=Number((paramRes.rows[0] as any).n)+Number((insumoDistRes.rows[0] as any).n)
  const mix_caixas=Number((mixRes.rows[0] as any).n)
  const total=Number((emRes.rows[0] as any).total)
  const com_minimo=Number((emRes.rows[0] as any).com_minimo)
  const estoque_minimo_suporta_canal=total>0&&com_minimo===total
  const [insumosFornRes,insumosConsumoRes,marcasRJRes]=await Promise.all([
    c.env.DB.query('SELECT DISTINCT insumo FROM fornecedores ORDER BY insumo',[]),
    c.env.DB.query('SELECT DISTINCT insumo FROM consumo_mensal',[]),
    c.env.DB.query("SELECT DISTINCT marca FROM consumo_mensal WHERE cd='RJ'",[]),
  ])
  const insumosConsumo=new Set((insumosConsumoRes.rows as any[]).map((r:any)=>r.insumo))
  const marcasComRJ=new Set((marcasRJRes.rows as any[]).map((r:any)=>r.marca))
  const MARCAS_ESPERADAS_RJ=['LE','KOKESHI']
  const lacunas:Array<Record<string,unknown>>=[]
  for(const r of insumosFornRes.rows as any[]){if(!insumosConsumo.has(r.insumo)) lacunas.push({tipo:'insumo_sem_consumo',insumo:r.insumo})}
  for(const marca of MARCAS_ESPERADAS_RJ){if(!marcasComRJ.has(marca)) lacunas.push({tipo:'marca_sem_cd',marca,cd:'RJ'})}
  return c.json({fatores_consumo,mix_caixas,estoque_minimo_suporta_canal,lacunas,versao:'fundacao-v1'})
})

app.get('/api/admin/debug-sheet',async c=>{
  try{
    const resp=await fetch(SHEET_URL)
    if(!resp.ok) return c.json({error:`HTTP ${resp.status}`},500)
    const csv=await resp.text()
    const lines=csv.split('\n')
    const hdrs=csvLine(lines[0]).map(h=>(h||'').trim().toLowerCase())
    const get=(c:string[],idx:number):string=>idx>=0&&idx<c.length?(c[idx]||'').trim():''
    const ci=(...matches:string[])=>{for(const m of matches){const i=hdrs.findIndex(h=>h.includes(m));if(i>=0)return i};return -1}
    const marcaIdx=ci('marca');const semanaIdx=ci('número_semana','numero_semana','semana')
    const recent:Array<{semana:string,marca_raw:string,marca_norm:string}>=[]
    for(let i=Math.max(1,lines.length-30);i<lines.length;i++){
      const c=csvLine(lines[i]);const raw=get(c,marcaIdx);if(!raw) continue
      recent.push({semana:get(c,semanaIdx),marca_raw:raw,marca_norm:normMarca(raw)})
    }
    return c.json({total_rows:lines.length-1,recent})
  }catch(e:any){return c.json({error:e.message},500)}
})

app.post('/api/admin/update-kraft',async c=>{
  await initDb(c.env.DB)
  const antes=await c.env.DB.query("SELECT marca,cd,consumo_mes FROM consumo_mensal WHERE insumo='FillPack' ORDER BY marca,cd",[])
  const antesMap:Record<string,number>={};for(const r of antes.rows as any[]) antesMap[`${r.marca}/${r.cd}`]=Number(r.consumo_mes)
  let updated=0
  for(const u of KRAFT_FILLPACK_V2){
    const res=await c.env.DB.exec("UPDATE consumo_mensal SET consumo_mes=? WHERE marca=? AND cd=? AND insumo='FillPack'",[u.consumo_mes,u.marca,u.cd])
    if(res.rowsWritten>0) updated++
  }
  await recalcMinimums(c.env.DB)
  const depois=await c.env.DB.query("SELECT marca,cd,consumo_mes FROM consumo_mensal WHERE insumo='FillPack' ORDER BY marca,cd",[])
  const resultado=(depois.rows as any[]).map(r=>({marca:r.marca,cd:r.cd,antes:antesMap[`${r.marca}/${r.cd}`]??null,depois:Number(r.consumo_mes)}))
  const emMin=await c.env.DB.query("SELECT marca,cd,insumo,est_min,alerta_threshold FROM estoque_minimo WHERE insumo='FillPack' ORDER BY marca,cd",[])
  return c.json({ok:true,coeficiente_novo:KRAFT_COEF,linhas_atualizadas:updated,consumo_mensal:resultado,estoques_minimos_recalculados:emMin.rows})
})

app.get('/api/dashboard',async c=>{
  await initDb(c.env.DB)
  const now=new Date();const sem=getISOWeek(now);const mes=now.getMonth()+1
  const[fr,s27r,ur,cr,er,ar]=await Promise.all([
    c.env.DB.query('SELECT marca,filled_at FROM fills_semana WHERE semana=? AND mes=?',[sem,mes]),
    c.env.DB.query('SELECT marca,filled_at FROM fills_semana WHERE semana=27 AND mes=7',[]),
    c.env.DB.query("SELECT COUNT(*) as n FROM alertas WHERE lido=0",[]),
    c.env.DB.query("SELECT COUNT(*) as n FROM alertas WHERE tipo='ESTOQUE_MINIMO' AND lido=0",[]),
    c.env.DB.query("SELECT COUNT(*) as n FROM alertas WHERE tipo IN ('ENTRADA','SAIDA_ANORMAL') AND lido=0",[]),
    c.env.DB.query("SELECT COUNT(*) as n FROM alertas WHERE tipo='ESTOQUE_MINIMO' AND acionado=0 AND lido=0",[]),
  ])
  const fm=new Map((fr.rows as any[]).map(r=>[r.marca,r.filled_at]))
  const s27m=new Map((s27r.rows as any[]).map(r=>[r.marca,r.filled_at]))
  return c.json({
    semana:sem,mes,
    fillsStatus:MARCAS_ESPERADAS.map(m=>({marca:m,filled:fm.has(m),filled_at:fm.get(m)??null})),
    lastSnapshot:{semana:27,mes:7,fillsStatus:MARCAS_ESPERADAS.map(m=>({marca:m,filled:s27m.has(m),filled_at:s27m.get(m)??null}))},
    stats:{totalMarcas:MARCAS_ESPERADAS.length,filledCount:fm.size,
      unreadAlerts:Number((ur.rows[0] as any).n),criticalAlerts:Number((cr.rows[0] as any).n),
      entradaAlerts:Number((er.rows[0] as any).n),pendingAction:Number((ar.rows[0] as any).n)}
  })
})

// Situação física de cada pool, usada para corrigir o Status do Snapshot.
// Consumo do pool = soma do consumo mensal das marcas do pool (consumo_mensal).
// Estoque do pool = soma do que as marcas do pool reportaram.
// Trânsito NÃO entra: o Status reflete a situação física atual.
// Situação física de cada pool, usada pelo Snapshot, pela Visão Consolidada,
// pela lista de Ação Imediata e pelo contador de críticos.
// ESTOQUE = submissões (físico atual). CONSUMO = Forecast vigente, pela mesma
// função poolsDoForecast usada por Planejamento e Sugestão de Compra.
// O histórico consumo_mensal continua no banco, mas não determina mais o
// Status operacional nem a necessidade futura.
async function poolStatusAtual(db:DB,ano?:number,mes?:number){
  const fc=await poolsDoForecast(db,ano,mes)
  const out:Record<string,any>={}
  for(const p of fc.pools){
    const def=POOLS.find(x=>x.chave===p.pool)
    out[p.pool]={
      pool:p.pool,label:p.label,insumo:p.insumo,cd:p.cd,
      marcas:p.marcas,marca_referencia:def?def.marcas[0]:p.marcas[0],
      periodo_forecast:fc.periodo,fallback_periodo:fc.fallback_periodo,
      fonte_consumo:'Forecast vigente',
      regra_status:p.regra_status,
      consumo_mensal:p.consumo_mensal,consumo_dia:p.consumo_dia,
      consumo_lead_time:p.consumo_lead_time,estoque_minimo:p.estoque_minimo,
      // estoque_pool = POSICAO OPERACIONAL DE HOJE (base do risco imediato do
      // card de criticos, com fallback para o snapshot quando não há posição
      // operacional calculável). estoque_atual é o snapshot puro (auditoria/
      // histórico) — NÃO é mais a base da Sugestão de Compra nem de
      // cobertura/status/compra_sugerida nesta mesma resposta: todos esses já
      // vêm da posição operacional (ver estoque_estimado_hoje/estoque_pool).
      // Consumidores de UI/export devem usar estoque_pool (ou
      // estoque_estimado_hoje), nunca estoque_atual, para exibir "estoque
      // atual" ao lado de cobertura/status/compra — ver v76.
      estoque_pool:p.estoque_operacional_hoje??p.estoque_atual,estoque_atual:p.estoque_atual,
      estoque_operacional_hoje:p.estoque_operacional_hoje,
      cobertura_operacional_dias:p.cobertura_operacional_dias,
      status_operacional:p.status_operacional,
      status_snapshot:p.status_snapshot,cobertura_dias_snapshot:p.cobertura_dias_snapshot,
      base_compra_sugerida:p.base_compra_sugerida,
      consumo_estimado_desde_snapshot:p.consumo_estimado_desde_snapshot,
      pct_consumo_estimado_sobre_snapshot:p.pct_consumo_estimado_sobre_snapshot,
      estimativa_material:p.estimativa_material,origem_variacao:p.origem_variacao,
      frescor_snapshot:p.frescor_snapshot,confiabilidade_posicao:p.confiabilidade_posicao,
      revisao_recomendada:p.revisao_recomendada,
      // Posições de estoque com nomes inequívocos
      estoque_snapshot:p.estoque_snapshot,data_snapshot:p.data_snapshot,
      estoque_estimado_hoje:p.estoque_estimado_hoje,
      cobertura_estimada_hoje:p.cobertura_estimada_hoje,
      recebido_apos_snapshot:p.recebido_apos_snapshot,
      detalhe_recebidos:p.detalhe_recebidos,
      ambiguidades_mesmo_dia:p.ambiguidades_mesmo_dia,
      saidas_apos_snapshot:p.saidas_apos_snapshot,saidas_sem_data:p.saidas_sem_data,
      detalhe_saidas:p.detalhe_saidas,
      detalhe_estimativa:p.detalhe_estimativa,
      estoque_projetado_futuro:p.estoque_projetado_futuro,
      data_projecao:p.data_projecao,data_ruptura_projetada:p.data_ruptura_projetada,
      eventos_projecao:p.eventos_projecao,
      transito_confiavel:p.transito_confiavel,transito_vencido:p.transito_vencido,
      detalhe_transito_vencido:p.detalhe_transito_vencido,recebidos:p.recebidos,
      margem_lt:p.margem_lt,prioridade:p.prioridade,
      data_limite_pedido:p.data_limite_pedido,dias_ate_limite_pedido:p.dias_ate_limite_pedido,
      status_pedido:p.status_pedido,dias_atraso_pedido:p.dias_atraso_pedido,
      motivo_pedido:p.motivo_pedido,lead_time_dias_corridos:p.lead_time_dias_corridos,
      projecao_confiavel:p.projecao_confiavel,alerta_projecao:p.alerta_projecao,
      base_status:p.base_status,base_proximo_pedido:p.base_proximo_pedido,
      saidas_futuras:p.saidas_futuras,
      gap_para_meta:p.gap_para_meta,
      cobertura_dias:p.cobertura_dias,
      lead_time:p.lead_time,limite_alerta_dias:p.limite_alerta_dias,
      status:p.status,
      estoque_transito:p.estoque_transito,data_prevista:p.data_prevista,
      estoque_pos_chegada:p.estoque_pos_chegada,
      cobertura_pos_chegada:p.cobertura_pos_chegada,
      ruptura_antes_da_chegada:p.ruptura_antes_da_chegada,
      timeline_transito:p.timeline_transito,
      estoque_alvo:p.estoque_alvo,compra_sugerida:p.compra_sugerida,
      detalhe_consumo:p.detalhe_consumo,detalhe_estoque:p.detalhe_estoque,
    }
  }
  return out
}

app.get('/api/snapshot',async c=>{
  await initDb(c.env.DB)
  const today=new Date()
  const q=c.req.query()
  const poolsAtual=await poolStatusAtual(c.env.DB,q.ano?Number(q.ano):undefined,q.mes?Number(q.mes):undefined)
  const lat=await c.env.DB.query(`SELECT s.* FROM submissions s INNER JOIN(SELECT marca,cd,canal,MAX(semana) as max_sem FROM submissions WHERE NOT(cd='SP' AND canal='B2C') GROUP BY marca,cd,canal) latest ON s.marca=latest.marca AND s.cd=latest.cd AND s.canal=latest.canal AND s.semana=latest.max_sem ORDER BY s.marca,s.cd,s.canal`,[])
  const em=await c.env.DB.query('SELECT * FROM estoque_minimo',[])
  const emMap:Record<string,Record<string,{est_min:number;alerta_threshold:number}>>={};
  for(const r of em.rows as any[]){const k=`${r.marca}|${r.cd}`;if(!emMap[k])emMap[k]={};emMap[k][r.insumo]={est_min:r.est_min,alerta_threshold:r.alerta_threshold}}
  const FL=[{field:'caixa_pp',label:'Caixa PP'},{field:'caixa_p',label:'Caixa P'},{field:'caixa_m',label:'Caixa M'},{field:'caixa_g',label:'Caixa G'},{field:'caixa_gg',label:'Caixa GG'},{field:'envelope_p',label:'Envelope P'},{field:'envelope_m',label:'Envelope M'},{field:'fita_gomada',label:'Fita Gomada'},{field:'fill_pack',label:'FillPack'}]
  return c.json((lat.rows as any[]).map(sub=>{
    const k=`${sub.marca}|${sub.cd}`;const em=emMap[k]||{}
    const insumoStatus=FL.map(ins=>{
      const base=enrichInsumo(ins.field,ins.label,Number(sub[ins.field]??0),em[ins.label],today)
      // Insumo com estoque físico compartilhado: a criticidade é do POOL.
      // Uma marca com saldo 0 não gera crítico se o CD tem cobertura.
      // Insumo descontinuado para a marca (FillPack RITUÁRIA): fora do
      // cálculo e da contagem de status.
      if(INSUMO_DESCONTINUADO.some(x=>x.marca===sub.marca&&x.insumo===ins.label))
        return{...base,status:'NA',status_individual:base.status,nao_utiliza:true,
          conta_status:false,
          observacao_pool:`${sub.marca} não utiliza ${ins.label}. Fora do cálculo e da contagem de status.`}
      const p=poolDe(ins.label,String(sub.marca),String(sub.cd))
      const pa=p?poolsAtual[p.chave]:null
      if(!pa) return{...base,conta_status:true}
      const mapa:Record<string,string>={CRITICO:'CRITICAL',ALERTA:'WARNING',OK:'OK',SEM_ESTOQUE:'NA'}
      return{...base,
        status:mapa[pa.status]??base.status,
        status_pool:pa.status,
        compartilhado:true,pool:pa.pool,pool_label:pa.label,
        pool_estoque:pa.estoque_pool,pool_cobertura_dias:pa.cobertura_dias,
        pool_lead_time:pa.lead_time,pool_limite_alerta_dias:pa.limite_alerta_dias,
        pool_consumo_dia:pa.consumo_dia,
        pool_consumo_lead_time:pa.consumo_lead_time,
        pool_estoque_minimo:pa.estoque_minimo,
        pool_transito:pa.estoque_transito,pool_data_prevista:pa.data_prevista,
        pool_estoque_pos_chegada:pa.estoque_pos_chegada,
        pool_cobertura_pos_chegada:pa.cobertura_pos_chegada,
        pool_ruptura_antes_da_chegada:pa.ruptura_antes_da_chegada,
        pool_timeline:pa.timeline_transito,
        status_individual:base.status,
        // Cada pool é contabilizado uma única vez, na marca de referência.
        // Cada pool conta uma única vez: na marca de referência e no canal B2C
        // (o pool é montado a partir das submissões B2C do CD).
        conta_status:String(sub.marca)===pa.marca_referencia&&String(sub.canal).toUpperCase()==='B2C',
        observacao_pool:`Status vem de ${pa.label} (cobertura ${pa.cobertura_dias??'—'} d). Saldo desta marca é apenas rastreabilidade.`}
    })
    const critCount=insumoStatus.filter((i:any)=>i.status==='CRITICAL'&&i.conta_status!==false).length
    const warnCount=insumoStatus.filter((i:any)=>i.status==='WARNING'&&i.conta_status!==false).length
    const minCobDias=insumoStatus.filter(i=>i.cobertura_dias!=null&&i.cobertura_dias>=0).reduce((m,i)=>Math.min(m,i.cobertura_dias!),999)
    return{...sub,insumoStatus,critCount,warnCount,min_cobertura_dias:minCobDias===999?null:minCobDias}
  }))
})

// Situação física dos pools (base do Status corrigido do Snapshot).
app.get('/api/pools/status',async c=>{
  await initDb(c.env.DB)
  const q=c.req.query()
  return c.json(Object.values(await poolStatusAtual(c.env.DB,q.ano?Number(q.ano):undefined,q.mes?Number(q.mes):undefined)))
})

app.get('/api/alertas',async c=>{
  await initDb(c.env.DB)
  const limit=Math.min(Number(c.req.query('limit')??100),200)
  const tipo=c.req.query('tipo');const acionado=c.req.query('acionado')
  let sql='SELECT * FROM alertas';const p:unknown[]=[]
  const conditions=[]
  if(tipo) conditions.push('tipo=?')&&p.push(tipo)
  if(acionado==='0') conditions.push('acionado=0')
  if(conditions.length) sql+=' WHERE '+conditions.join(' AND ')
  sql+=' ORDER BY created_at DESC LIMIT ?';p.push(limit)
  return c.json((await c.env.DB.query(sql,p)).rows)
})

app.post('/api/alertas/:id/acionar',async c=>{
  await initDb(c.env.DB)
  const id=Number(c.req.param('id'))
  await c.env.DB.exec("UPDATE alertas SET acionado=1,acionado_at=datetime('now'),lido=1 WHERE id=?",[id])
  return c.json({ok:true,id})
})

app.get('/api/estoque-minimo',async c=>{await initDb(c.env.DB);return c.json((await c.env.DB.query('SELECT * FROM estoque_minimo ORDER BY marca,cd,insumo',[])).rows)})

app.get('/api/historico',async c=>{
  await initDb(c.env.DB)
  const limit=Math.min(Number(c.req.query('limit')??200),500)
  const marca=c.req.query('marca')
  let sql='SELECT * FROM submissions';const p:unknown[]=[]
  if(marca){sql+=' WHERE marca=?';p.push(marca)}
  sql+=' ORDER BY semana DESC,marca,cd,canal LIMIT ?';p.push(limit)
  return c.json((await c.env.DB.query(sql,p)).rows)
})

app.get('/api/parametros',async c=>{
  await initDb(c.env.DB)
  const[pr,cr]=await Promise.all([c.env.DB.query('SELECT * FROM parametros ORDER BY chave',[]),c.env.DB.query('SELECT * FROM consumo_mensal ORDER BY marca,cd,insumo',[])])
  return c.json({parametros:pr.rows,consumo_mensal:cr.rows})
})

app.post('/api/parametros',async c=>{
  await initDb(c.env.DB)
  let body:any;try{body=await c.req.json()}catch{return c.json({error:'Invalid JSON'},400)}
  if(!body.parametros||!Array.isArray(body.parametros)) return c.json({error:'Expected {parametros:[{chave,valor}]}'},400)
  for(const p of body.parametros){
    if(!p.chave||p.valor===undefined) continue
    await c.env.DB.exec("UPDATE parametros SET valor=?,updated_at=datetime('now') WHERE chave=?",[Number(p.valor),p.chave])
  }
  // ── v72: recalcular pelo MESMO Forecast usado em Sugestão de Compra,
  // Planejamento e na aba Est. Mínimo — não mais pela tabela legada
  // consumo_mensal (recalcMinimums). Mês/ano vigentes = data de hoje, mesmo
  // default de /api/planejamento/aplicar-estoque-minimo.
  const now=new Date()
  const ano=now.getFullYear();const mes=now.getMonth()+1
  const r=await calcularEstoqueMinimoForecast(c.env.DB,ano,mes,true)
  if(!r.ok){
    // Parâmetros já foram salvos — isso não falha por falta de Forecast.
    // Só informa que o recálculo não pôde rodar, sem reverter nada.
    return c.json({ok:true,parametros_salvos:true,recalculado:false,ano,mes,motivo:r.error})
  }
  return c.json({ok:true,parametros_salvos:true,recalculado:true,ano,mes,
    recalculated:r.itens.length,ignorados:r.ignorados.length})
})

app.get('/api/fornecedores',async c=>{await initDb(c.env.DB);return c.json((await c.env.DB.query('SELECT * FROM fornecedores ORDER BY insumo,uf',[])).rows)})

app.post('/api/fornecedores/:id/preco',async c=>{
  await initDb(c.env.DB)
  const id=Number(c.req.param('id'))
  let body:any;try{body=await c.req.json()}catch{return c.json({error:'Invalid JSON'},400)}
  if(!body.valor_un||isNaN(Number(body.valor_un))) return c.json({error:'Missing valor_un'},400)
  await c.env.DB.exec('UPDATE fornecedores SET valor_un=? WHERE id=?',[Number(body.valor_un),id])
  return c.json({ok:true,id,valor_un:Number(body.valor_un)})
})

app.get('/api/sla',async c=>{
  await initDb(c.env.DB)
  const res=await c.env.DB.query('SELECT marca,COUNT(*) as total_fills,MIN(semana) as primeira_semana,MAX(semana) as ultima_semana,MAX(filled_at) as ultimo_fill FROM fills_semana GROUP BY marca ORDER BY marca',[])
  const maxSem=await c.env.DB.query('SELECT MAX(semana) as ms FROM fills_semana',[])
  const maxS=Number((maxSem.rows[0] as any)?.ms??27)
  return c.json((res.rows as any[]).map(r=>{
    const possivel=r.ultima_semana-r.primeira_semana+1;const taxa=possivel>0?Math.round((r.total_fills/possivel)*100):0
    return{...r,taxa_fill:taxa,semanas_possiveis:possivel,semanas_faltou:possivel-r.total_fills,semanas_atras:maxS-r.ultima_semana}
  }))
})

app.get('/api/tendencia',async c=>{
  await initDb(c.env.DB)
  const res=await c.env.DB.query('SELECT * FROM submissions WHERE semana >= (SELECT MAX(semana)-3 FROM submissions) ORDER BY marca,cd,canal,semana DESC',[])
  const groups:Record<string,any[]>={}
  for(const r of res.rows as any[]){const k=`${r.marca}|${r.cd}|${r.canal}`;if(!groups[k])groups[k]=[];groups[k].push(r)}
  return c.json(Object.entries(groups).map(([key,rows])=>{
    const[marca,cd,canal]=key.split('|');const sorted=[...rows].sort((a,b)=>b.semana-a.semana)
    const current=sorted[0];const prev=sorted[1]
    const trend=['caixa_pp','caixa_p','caixa_m','caixa_g','caixa_gg','fita_gomada','fill_pack'].map(f=>{
      const cur=Number(current?.[f]??0);const prv=Number(prev?.[f]??0);const delta=cur-prv
      return{field:f,label:INSUMO_ALERT_FIELDS[f]??f,current:cur,previous:prv,delta,pct_change:prv>0?Math.round((delta/prv)*100):null,dir:delta>0?'up':delta<0?'down':'flat'}
    })
    return{marca,cd,canal,semana_atual:current?.semana,semana_prev:prev?.semana,trend}
  }))
})

app.post('/api/alertas/read-all',async c=>{await initDb(c.env.DB);await c.env.DB.exec("UPDATE alertas SET lido=1 WHERE lido=0",[]);return c.json({ok:true})})

app.get('/api/admin/test-chat',async c=>{
  if(!c.env.GOOGLE_CHAT_WEBHOOK) return c.json({error:'GOOGLE_CHAT_WEBHOOK not configured'})
  await sendChat(c.env.GOOGLE_CHAT_WEBHOOK,'✅ *Hub de Insumos — Webhook configurado!*\n\nHub: https://hub-insumos.devgogroup.com/')
  return c.json({ok:true})
})

app.post('/api/admin/migrate',async c=>{
  await initDb(c.env.DB)
  await c.env.DB.exec("UPDATE consumo_mensal SET unidade='BOBINA' WHERE insumo='FillPack'",[])
  await recalcMinimums(c.env.DB)
  const cnt=await c.env.DB.query("SELECT COUNT(*) as n FROM consumo_mensal WHERE insumo='FillPack' AND unidade='BOBINA'",[])
  return c.json({ok:true,fillpack_bobina_rows:Number((cnt.rows[0] as any).n)})
})

app.post('/api/admin/dedup-alerts',async c=>{
  await initDb(c.env.DB)
  await c.env.DB.exec("DELETE FROM alertas WHERE id NOT IN(SELECT MAX(id) FROM alertas GROUP BY tipo,marca,cd,COALESCE(insumo,''))",[])
  const cnt=await c.env.DB.query('SELECT COUNT(*) as n FROM alertas',[])
  return c.json({ok:true,remaining:Number((cnt.rows[0] as any).n)})
})

app.post('/api/cron/sync-sheet',async c=>{
  await initDb(c.env.DB)
  const isCron=!!c.req.header('x-godeploy-cron')
  const isAuth=!c.env.WEBHOOK_SECRET||c.req.header('x-webhook-secret')===c.env.WEBHOOK_SECRET
  if(!isCron&&!isAuth) return c.json({error:'Unauthorized'},401)
  try{
    const result=await syncSheet(c.env.DB)
    if(c.env.GOOGLE_CHAT_WEBHOOK){
      const newCrits=await c.env.DB.query("SELECT marca,cd,insumo,mensagem FROM alertas WHERE tipo='ESTOQUE_MINIMO' AND created_at > datetime('now','-10 minutes') ORDER BY marca,cd",[])
      if(newCrits.rows.length>0){
        const lines=(newCrits.rows as any[]).map((r:any)=>`  • *${r.marca} ${r.cd}* — ${r.insumo}: ${String(r.mensagem).split('—')[1]?.trim()||r.mensagem}`).join('\n')
        await sendChat(c.env.GOOGLE_CHAT_WEBHOOK,`🔴 *ACIONAR COMPRA*\nSemana ${result.semana} · ${newCrits.rows.length} item(s)\n\n${lines}\n\nhttps://hub-insumos.devgogroup.com/`)
      }
    }
    return c.json({ok:true,...result})
  }catch(e:any){return c.json({error:e.message},500)}
})

app.post('/api/webhook/submit',async c=>{
  await initDb(c.env.DB)
  const wh=c.req.header('x-webhook-secret')
  if(c.env.WEBHOOK_SECRET&&wh!==c.env.WEBHOOK_SECRET) return c.json({error:'Unauthorized'},401)
  let data:Record<string,unknown>
  try{data=await c.req.json()}catch{return c.json({error:'Invalid JSON'},400)}
  const marca=normMarca(String(data.marca??''));const canal=String(data.canal??'B2C').toUpperCase()
  const{semana,mes,cd}=data as any
  if(!semana||!mes||!marca||!cd) return c.json({error:'Missing: semana,mes,marca,cd'},400)
  await c.env.DB.exec(`INSERT OR REPLACE INTO submissions(semana,mes,marca,cd,canal,caixa_pp,caixa_p,caixa_m,caixa_g,caixa_gg,envelope_p,envelope_m,fill_pack,papel_colmeia,fita_gomada,plastico_bolha) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [semana,mes,marca,cd,canal,Number(data.caixa_pp??0),Number(data.caixa_p??0),Number(data.caixa_m??0),Number(data.caixa_g??0),Number(data.caixa_gg??0),Number(data.envelope_p??0),Number(data.envelope_m??0),Number(data.fill_pack??0),Number(data.papel_colmeia??0),Number(data.fita_gomada??0),Number(data.plastico_bolha??0)])
  await c.env.DB.exec("INSERT OR REPLACE INTO fills_semana(semana,mes,marca,filled_at) VALUES(?,?,?,datetime('now'))",[semana,mes,marca])
  await c.env.DB.exec("INSERT INTO alertas(tipo,marca,cd,canal,mensagem) VALUES('PREENCHIMENTO',?,?,?,?)",[marca,cd,canal,`${marca} (${cd}·${canal}) preencheu semana ${semana}.`])
  const gen=await generateAlerts(c.env.DB,{...data,marca,canal})
  await sendEmail(c.env,`✅ ${marca} (${cd}·${canal}) preencheu — Semana ${semana}`,tplFillOk(marca,cd,Number(semana),canal))
  if(gen.length>0) await sendEmail(c.env,`🔔 ${gen.length} alertas ${marca} ${cd} — Semana ${semana}`,tplAlerts(marca,cd,canal,Number(semana),gen))
  const critOnSubmit=gen.filter(a=>a.tipo==='ESTOQUE_MINIMO')
  if(critOnSubmit.length>0&&c.env.GOOGLE_CHAT_WEBHOOK){
    const lines=critOnSubmit.map(a=>`  • *${a.insumo}*: ${a.mensagem.split('—')[1]?.trim()||a.mensagem}`).join('\n')
    await sendChat(c.env.GOOGLE_CHAT_WEBHOOK,`🔴 *ACIONAR COMPRA — ${marca} ${cd} (${canal})*\nSemana ${semana} · ${critOnSubmit.length} item(s) crítico(s)\n\n${lines}\n\nhttps://hub-insumos.devgogroup.com/`)
  }
  return c.json({ok:true,semana,marca,cd,canal,alertsGenerated:gen.length})
})

app.post('/api/webhook/check-week',async c=>{
  await initDb(c.env.DB)
  const isCron=!!c.req.header('x-godeploy-cron')
  const isN8n=!c.env.WEBHOOK_SECRET||c.req.header('x-webhook-secret')===c.env.WEBHOOK_SECRET
  if(!isCron&&!isN8n) return c.json({error:'Unauthorized'},401)
  let body:any={};try{body=await c.req.json()}catch{}
  const now=new Date();const sem=Number(body.semana??getISOWeek(now));const mes=Number(body.mes??(now.getMonth()+1))
  const fr=await c.env.DB.query('SELECT marca FROM fills_semana WHERE semana=? AND mes=?',[sem,mes])
  const filled=new Set((fr.rows as any[]).map(r=>r.marca))
  const missing=MARCAS_ESPERADAS.filter(m=>!filled.has(m))
  for(const marca of missing){
    const already=await c.env.DB.query("SELECT id FROM alertas WHERE tipo='FALTA_PREENCHIMENTO' AND marca=? AND insumo=?",[marca,`sem_${sem}`])
    if(!already.rows.length){
      await c.env.DB.exec("INSERT INTO alertas(tipo,marca,mensagem,insumo) VALUES('FALTA_PREENCHIMENTO',?,?,?)",[marca,`${marca} não preencheu semana ${sem}.`,`sem_${sem}`])
      await sendEmail(c.env,`⚠️ ${marca} não preencheu — Semana ${sem}`,tplMissing(marca,sem))
      await sendChat(c.env.GOOGLE_CHAT_WEBHOOK,`⚠️ *PREENCHIMENTO AUSENTE*\n*Marca:* ${marca}\n*Semana:* ${sem}`)
    }
  }
  return c.json({semana:sem,mes,filled:[...filled],missing})
})

// ── Forecast API ──────────────────────────────────────────────────────────────

app.get('/api/mix-cd',async c=>{
  await initDb(c.env.DB)
  return c.json((await c.env.DB.query('SELECT * FROM mix_cd ORDER BY marca,cd',[])).rows)
})

app.get('/api/mix-caixas',async c=>{
  await initDb(c.env.DB)
  return c.json((await c.env.DB.query('SELECT * FROM mix_caixas ORDER BY marca,cd',[])).rows)
})

// Atualiza o Mix Final de caixas (distribuição PP/P/M/G/GG) de uma
// marca+CD. Alimenta diretamente planejarCombinacao() -> consumo_projetado
// por tamanho -> Forecast, pools, cobertura e Sugestão de Compra (fonte
// única — nenhuma tela usa um mix diferente). Validação: os 5 percentuais
// devem somar 1 (tolerância 0.001, cobre arredondamento de 4 casas) — um
// mix que não fecha 100% deixaria de representar uma distribuição válida
// de pedidos entre tamanhos.
app.patch('/api/mix-caixas/:marca/:cd',async c=>{
  await initDb(c.env.DB)
  const marca=String(c.req.param('marca')).toUpperCase()
  const cd=String(c.req.param('cd')).toUpperCase()
  let b:any;try{b=await c.req.json()}catch{return c.json({error:'Invalid JSON'},400)}
  const ex=await c.env.DB.query('SELECT * FROM mix_caixas WHERE marca=? AND cd=?',[marca,cd])
  if(!ex.rows.length) return c.json({error:`Mix não cadastrado para ${marca} (${cd}). Este endpoint só atualiza combinações já existentes.`},404)
  const cur=ex.rows[0] as any
  const val=(k:string)=>{
    if(b[k]===undefined) return Number(cur[k])
    const n=Number(b[k])
    if(isNaN(n)||n<0) throw new Error(`${k} inválido: deve ser um percentual >= 0 (fração 0–1)`)
    return n
  }
  let pp:number,p:number,m:number,g:number,gg:number
  try{pp=val('pp');p=val('p');m=val('m');g=val('g');gg=val('gg')}
  catch(e:any){return c.json({error:e.message},400)}
  const soma=r2(pp+p+m+g+gg)
  if(Math.abs(soma-1)>0.001)
    return c.json({error:`Os percentuais devem somar 100%. Soma atual: ${Math.round(soma*1000)/10}% (pp=${pp},p=${p},m=${m},g=${g},gg=${gg}).`},400)
  await c.env.DB.exec(`UPDATE mix_caixas SET pp=?,p=?,m=?,g=?,gg=?,fonte=?,updated_at=datetime('now') WHERE marca=? AND cd=?`,
    [pp,p,m,g,gg,b.fonte||cur.fonte,marca,cd])
  const nr=await c.env.DB.query('SELECT * FROM mix_caixas WHERE marca=? AND cd=?',[marca,cd])
  return c.json({ok:true,action:'mix_atualizado',mix_anterior:cur,mix_novo:nr.rows[0]})
})

app.get('/api/forecast',async c=>{
  await initDb(c.env.DB)
  const q=c.req.query()
  let sql='SELECT * FROM forecast_mensal WHERE 1=1';const p:unknown[]=[]
  if(q.ano){sql+=' AND ano=?';p.push(Number(q.ano))}
  if(q.mes){sql+=' AND mes=?';p.push(Number(q.mes))}
  if(q.marca){sql+=' AND marca=?';p.push(q.marca)}
  if(q.canal){sql+=' AND canal=?';p.push(q.canal)}
  sql+=' ORDER BY ano DESC,mes DESC,marca,canal'
  return c.json((await c.env.DB.query(sql,p)).rows)
})

app.get('/api/forecast/distribuido',async c=>{
  await initDb(c.env.DB)
  const q=c.req.query()
  let sql='SELECT * FROM forecast_mensal WHERE 1=1';const p:unknown[]=[]
  if(q.ano){sql+=' AND ano=?';p.push(Number(q.ano))}
  if(q.mes){sql+=' AND mes=?';p.push(Number(q.mes))}
  sql+=' ORDER BY marca,canal'
  const forecasts=(await c.env.DB.query(sql,p)).rows as any[]
  const mixRows=(await c.env.DB.query('SELECT * FROM mix_cd ORDER BY marca,cd',[])).rows as any[]
  // Monta mapa de % por marca — sempre lido da tabela, nunca hardcoded
  const mixMap:Record<string,{cd:string;pct_cd:number}[]>={}
  for(const r of mixRows){if(!mixMap[r.marca])mixMap[r.marca]=[];mixMap[r.marca].push({cd:r.cd,pct_cd:Number(r.pct_cd)})}
  return c.json(forecasts.map(f=>{
    // Marketplace opera em SP e MG, mas a distribuicao percentual entre os
    // dois ainda nao foi definida. O mix_cd da marca é uma premissa B2C
    // (ex.: BB ES 90%/RJ 10%) e NAO deve ser reaproveitado para Marketplace —
    // isso rotearia demanda de Marketplace silenciosamente para ES/RJ.
    if(String(f.canal).toUpperCase()==='MARKETPLACE'){
      return{id:f.id,ano:f.ano,mes:f.mes,marca:f.marca,canal:f.canal,
        forecast_pedidos:f.forecast_pedidos,distribuicao:[],updated_at:f.updated_at,
        bloqueio:{motivo:'DISTRIBUICAO_CD_PENDENTE',
          mensagem:'Marketplace opera em SP e MG, mas a distribuição percentual entre os dois CDs ainda não foi definida. Nenhum forecast foi distribuído automaticamente.'}}
    }
    const mix=mixMap[f.marca]||[{cd:'ES',pct_cd:1.0}]
    const distribuicao=mix.map(m=>({
      cd:m.cd,pct_cd:m.pct_cd,
      pct_formatado:`${Math.round(m.pct_cd*100)}%`,
      forecast_cd:Math.round(Number(f.forecast_pedidos)*m.pct_cd)
    }))
    return{id:f.id,ano:f.ano,mes:f.mes,marca:f.marca,canal:f.canal,
      forecast_pedidos:f.forecast_pedidos,distribuicao,updated_at:f.updated_at}
  }))
})

app.post('/api/forecast',async c=>{
  await initDb(c.env.DB)
  let body:any;try{body=await c.req.json()}catch{return c.json({error:'Invalid JSON'},400)}
  const {canal='B2C',forecast_pedidos}=body
  const marca=body.marca?normMarca(String(body.marca)):null
  const ano=Number(body.ano);const mes=Number(body.mes)
  if(!ano||!mes||!marca||forecast_pedidos==null)
    return c.json({error:'Obrigatório: ano, mes, marca, forecast_pedidos'},400)
  const canalUp=String(canal).toUpperCase()
  const fpN=Number(forecast_pedidos)
  if(isNaN(ano)||isNaN(mes)||isNaN(fpN)||fpN<0) return c.json({error:'Valores numéricos inválidos'},400)
  const existing=await c.env.DB.query('SELECT id FROM forecast_mensal WHERE ano=? AND mes=? AND marca=? AND canal=?',[ano,mes,marca,canalUp])
  if(existing.rows.length){
    const id=Number((existing.rows[0] as any).id)
    await c.env.DB.exec("UPDATE forecast_mensal SET forecast_pedidos=?,updated_at=datetime('now') WHERE id=?",[fpN,id])
    return c.json({ok:true,action:'updated',id,ano,mes,marca,canal:canalUp,forecast_pedidos:fpN})
  }else{
    await c.env.DB.exec('INSERT INTO forecast_mensal(ano,mes,marca,canal,forecast_pedidos) VALUES(?,?,?,?,?)',[ano,mes,marca,canalUp,fpN])
    const nr=await c.env.DB.query('SELECT * FROM forecast_mensal WHERE ano=? AND mes=? AND marca=? AND canal=?',[ano,mes,marca,canalUp])
    return c.json({ok:true,action:'created',forecast:nr.rows[0]})
  }
})

app.delete('/api/forecast/:id',async c=>{
  await initDb(c.env.DB)
  const id=Number(c.req.param('id'))
  if(isNaN(id)) return c.json({error:'ID inválido'},400)
  await c.env.DB.exec('DELETE FROM forecast_mensal WHERE id=?',[id])
  return c.json({ok:true,id})
})

// ── Planejamento: consumo projetado / cobertura / estoque-alvo ────────────────
// Cadeia: Forecast -> distribuição CD -> fator/mix -> consumo projetado
//         -> consumo diário -> cobertura -> gatilho de compra -> compra sugerida
// Nenhum coeficiente é hardcoded na fórmula: tudo vem de parametros /
// fatores_consumo / mix_caixas / mix_cd.
//
// Regras vigentes (v41):
//  • FillPack e Fita Gomada: coeficiente em BOBINA/pedido. Sem conversão de kg.
//  • Estoque-alvo = consumo mensal projetado x meta_reposicao (2 meses).
//  • Gatilho de compra por insumo: consumo do lead time oficial
//    (PP 12d · P 7d · M 7d · G 9d · GG 9d · Fita 16d · FillPack 7,5d).
//    O threshold/alerta_fator NÃO é gatilho desses insumos.
//  • FillPack mantém lead time 7,5 d e o gatilho por estoque mínimo legado.
//  • FillPack e Fita são avaliados por POOL físico do CD (ver POOLS).

type Params=Record<string,number>

async function loadParams(db:DB):Promise<Params>{
  const r=await db.query('SELECT chave,valor FROM parametros',[])
  const P:Params={}
  for(const x of r.rows as any[]) P[x.chave]=Number(x.valor)
  return P
}

// Resolve nomes de parâmetro tolerando as duas convenções possíveis.
// Preserva SEMPRE o valor já configurado no sistema.
function resolveParam(P:Params,candidatos:string[],fallback:number){
  for(const c of candidatos) if(P[c]!==undefined) return{chave:c,valor:P[c],origem:'parametro'}
  return{chave:candidatos[0],valor:fallback,origem:'fallback'}
}

function calcEstoque(consumoMes:number,leadTime:number,diasBase:number,fatorSeg:number,fatorAlerta:number){
  const consumo_dia=consumoMes/diasBase
  const est_min=consumo_dia*leadTime*(1+fatorSeg)
  return{
    consumo_dia:Math.round(consumo_dia*100)/100,
    est_min:Math.round(est_min*100)/100,
    est_min_arred:Math.round(est_min),
    alerta:Math.round(est_min*fatorAlerta*100)/100,
    alerta_arred:Math.round(est_min*fatorAlerta),
  }
}

const r2=(n:number)=>Math.round(n*100)/100

// ── Classificação operacional do Status de um pool físico ────────────────────
// O Status responde duas perguntas, nesta ordem:
//   1) o estoque atual sustenta a operação até a próxima chegada confirmada?
//   2) depois de receber, o saldo atravessa um novo lead time de reposição?
// Entradas futuras são simuladas em ordem cronológica — nunca somadas como se
// chegassem hoje. Sem entradas, avalia-se o estoque físico atual.
//   CRÍTICO  ruptura antes de alguma chegada, OU saldo final <= ConsumoLeadTime
//   ALERTA   atravessa o lead time, mas saldo final < EstoqueMinimo
//   OK       saldo final >= EstoqueMinimo
// EstoqueMinimo é o já existente no Hub: consumo_dia x LT x (1 + fator_seguranca).
const FATOR_ALERTA_COBERTURA=1.30
const limiteAlertaDias=(leadTime:number)=>Math.ceil(leadTime*FATOR_ALERTA_COBERTURA)
function consumoLeadTime(consumoDia:number,leadTime:number){return consumoDia*leadTime}

type EntradaTransito={quantidade:number;data_prevista:string|null}

function diasAte(dataISO:string,hoje:Date){
  const d=new Date(String(dataISO).slice(0,10)+'T00:00:00Z')
  const h=new Date(hoje.toISOString().slice(0,10)+'T00:00:00Z')
  return Math.max(0,Math.round((d.getTime()-h.getTime())/86400000))
}

function classificarPool(opts:{
  estoque:number|null;consumoDia:number;leadTime:number;estoqueMinimo:number;
  entradas?:EntradaTransito[];hoje?:Date;
}){
  const{estoque,consumoDia,leadTime,estoqueMinimo}=opts
  const hoje=opts.hoje??new Date()
  const consumo_lead_time=r2(consumoLeadTime(consumoDia,leadTime))
  const base={
    consumo_lead_time,estoque_minimo:Math.round(estoqueMinimo),
    limite_alerta_dias:limiteAlertaDias(leadTime),
    regra_status:`CRÍTICO se romper antes de uma chegada ou se o saldo pós-chegada <= ${consumo_lead_time} (consumo do lead time) | ALERTA até ${Math.round(estoqueMinimo)} (estoque mínimo) | OK a partir daí`,
  }
  if(estoque==null) return{...base,status:'SEM_ESTOQUE',timeline:[],
    estoque_pos_chegada:null,cobertura_pos_chegada:null,ruptura_antes_da_chegada:false}

  // Entradas confirmadas, em ordem cronológica. Sem data => trata como imediata.
  const entradas=(opts.entradas??[])
    .filter(e=>Number(e.quantidade)>0)
    .map(e=>({qtd:Number(e.quantidade),data:e.data_prevista||null,
              dias:e.data_prevista?diasAte(e.data_prevista,hoje):0}))
    .sort((x,y)=>x.dias-y.dias)

  let saldo=estoque, diasAnterior=0, ruptura=false
  let dataRuptura:string|null=null
  const timeline:any[]=[]
  for(const e of entradas){
    const intervalo=Math.max(0,e.dias-diasAnterior)
    const consumoIntervalo=r2(consumoDia*intervalo)
    const antes=r2(saldo-consumoIntervalo)
    if(antes<0&&!ruptura){ruptura=true;dataRuptura=e.data}
    saldo=r2(antes+e.qtd)
    timeline.push({data:e.data,dias_ate:e.dias,consumo_no_intervalo:consumoIntervalo,
      estoque_antes_da_chegada:antes,entrada:e.qtd,estoque_apos_chegada:saldo})
    diasAnterior=e.dias
  }

  const estoque_pos_chegada=entradas.length?saldo:estoque
  const cobertura_pos_chegada=consumoDia>0?r2(estoque_pos_chegada/consumoDia):null
  const extra={...base,timeline,
    estoque_pos_chegada,cobertura_pos_chegada,
    ruptura_antes_da_chegada:ruptura,data_ruptura:dataRuptura}

  if(ruptura) return{...extra,status:'CRITICO'}
  if(estoque_pos_chegada<=consumo_lead_time) return{...extra,status:'CRITICO'}
  if(estoque_pos_chegada<estoqueMinimo) return{...extra,status:'ALERTA'}
  return{...extra,status:'OK'}
}

// Avaliação de reposição de um pool físico.
//   EstoqueProjetado (necessidade bruta) = MAX(0, EstoqueAlvo - EstoqueAtual)
//   SugestaoCompra                       = MAX(0, EstoqueProjetado - EmTransito)
// Status vem de classificarPool (consumo do lead time x estoque mínimo), sem trânsito.
function avaliarReposicao(opts:{
  consumoMes:number;consumoDia:number;leadTime:number;metaMeses:number;
  estoque:number|null;transito?:number;data_prevista?:string|null;estoqueMinimo?:number;
  entradas?:EntradaTransito[];
}){
  const{consumoMes,consumoDia,leadTime,metaMeses,estoque,data_prevista}=opts
  const transito=Number(opts.transito??0)
  const estoque_alvo=Math.round(consumoMes*metaMeses)
  const cobertura_dias=(estoque!=null&&isFinite(estoque)&&consumoDia>0)?r2(estoque/consumoDia):null
  const estoqueMinimo=opts.estoqueMinimo??consumoDia*leadTime*1.5
  const cls=classificarPool({estoque,consumoDia,leadTime,estoqueMinimo,entradas:opts.entradas})
  const estoque_projetado=estoque==null?null:Math.max(0,estoque_alvo-estoque)
  const compra_sugerida=estoque_projetado==null?null:Math.max(0,estoque_projetado-transito)
  return{
    estoque_atual:estoque,cobertura_dias,
    estoque_alvo,meta_meses:metaMeses,
    lead_time:leadTime,limite_alerta_dias:cls.limite_alerta_dias,
    consumo_lead_time:cls.consumo_lead_time,estoque_minimo:cls.estoque_minimo,
    estoque_pos_chegada:cls.estoque_pos_chegada,cobertura_pos_chegada:cls.cobertura_pos_chegada,
    ruptura_antes_da_chegada:cls.ruptura_antes_da_chegada,timeline_transito:cls.timeline,
    status:cls.status,
    // status_alerta preservado para compatibilidade da interface existente
    status_alerta:cls.status==='OK'?'OK':(cls.status==='SEM_ESTOQUE'?'SEM_ESTOQUE':'ALERTA_COMPRA'),
    // 'gap_para_meta' é o nome correto: quanto falta para a meta, ANTES do
    // trânsito. Não é estoque projetado — esse é calculado em consolidarPools.
    gap_para_meta:estoque_projetado,necessidade:estoque_projetado,
    estoque_projetado,
    estoque_transito:transito,data_prevista:data_prevista??null,
    compra_sugerida,
    regra_status:cls.regra_status,
    regra_compra:'MAX(0, MAX(0, alvo - estoque) - em trânsito)',
  }
}

// Qual pool avalia este insumo/marca/CD (FillPack e Fita são compartilhados).
function poolDe(insumo:string,marca:string,cd:string){
  return POOLS.find(p=>p.insumo===insumo&&p.cd===cd&&p.marcas.includes(marca))||null
}

// Núcleo reutilizável: dado marca/cd/canal/pedidos, devolve a trilha completa.
function planejarCombinacao(
  marca:string,cd:string,canal:string,pedidos:number,
  fatores:Record<string,any>,
  mix:Record<string,any>,
  P:Params,cfg:any,
  estoque:Record<string,number>={}
){
  const itens:any[]=[]
  const canalUp=String(canal).toUpperCase()

  // B2B: não gera estoque mínimo pela metodologia B2C até definir mix próprio.
  if(canalUp==='B2B'){
    return{itens:[],bloqueio:{
      motivo:'B2B_SEM_MIX',
      mensagem:'B2B não recebe estoque mínimo pela metodologia B2C. Aguarda definição de mix próprio.'
    }}
  }

  // ── Fita Gomada e FillPack — ambos em BOBINA/pedido ──
  // Consumo é individual (rastreabilidade). Estoque/cobertura/alerta/compra
  // são avaliados no POOL do CD, não por marca.
  for(const insumo of ['Fita Gomada','FillPack']){
    // Insumo descontinuado para a marca: não gera consumo nem necessidade.
    const desc=INSUMO_DESCONTINUADO.find(d=>d.marca===marca&&d.insumo===insumo)
    if(desc){
      itens.push({
        insumo,status:'NAO_UTILIZA',mensagem:desc.motivo,
        forecast_cd:pedidos,coeficiente:null,unidade:'BOBINA',
        consumo_projetado:0,consumo_projetado_arred:0,consumo_dia:0,
        lead_time:null,est_min:null,alerta:null,
        estoque_compartilhado:true,pool:null,pool_label:null,
      })
      continue
    }
    const f=fatores[`${marca}|${cd}|${insumo}`]
    const ltParam=resolveParam(P,[`lead_${insumo}`],leadTimeDe(insumo))
    // Sem linha, coef nulo ou status NAO_DEFINIDO => não calcula, não infere.
    if(!f||f.coef==null||f.status==='NAO_DEFINIDO'){
      itens.push({
        insumo,status:'FATOR_NAO_DEFINIDO',
        mensagem:`Fator de consumo não definido para ${marca} (${cd}). Nenhum coeficiente foi inferido de outra marca.`,
        forecast_cd:pedidos,coeficiente:null,unidade:null,
        consumo_projetado:null,consumo_dia:null,
        lead_time:null,fator_seguranca:cfg.fatorSeg.valor,
        est_min:null,alerta:null,
      })
      continue
    }
    // Lead time: prioriza o cadastrado na própria premissa; senão o parâmetro.
    const lt=f.lead_time_d??ltParam.valor
    const ltOrigem=f.lead_time_d!=null?'fatores_consumo.lead_time_d':ltParam.chave
    // Coeficiente JÁ é bobina/pedido para os dois insumos. Sem conversão.
    const consumo=pedidos*f.coef
    const e=calcEstoque(consumo,lt,cfg.diasBase.valor,cfg.fatorSeg.valor,cfg.fatorAlerta.valor)
    const pool=poolDe(insumo,marca,cd)
    itens.push({
      insumo,status:'OK',mensagem:null,
      forecast_cd:pedidos,
      coeficiente:f.coef,unidade_coef:f.unidade,unidade:'BOBINA',fonte_fator:f.fonte,
      formula:`${pedidos} x ${f.coef} = ${r2(consumo)} bobinas`,
      consumo_projetado:r2(consumo),
      consumo_projetado_arred:Math.round(consumo),
      consumo_dia:e.consumo_dia,
      dias_base:cfg.diasBase.valor,
      lead_time:lt,lead_time_param:ltOrigem,
      fator_seguranca:cfg.fatorSeg.valor,
      est_min:e.est_min,est_min_arred:e.est_min_arred,
      fator_alerta:cfg.fatorAlerta.valor,
      alerta:e.alerta,alerta_arred:e.alerta_arred,
      // Estoque compartilhado: avaliação fica no pool.
      estoque_compartilhado:true,
      pool:pool?pool.chave:null,pool_label:pool?pool.label:null,
      observacao_estoque:pool
        ? `Estoque, cobertura, alerta e compra avaliados em ${pool.label}.`
        : 'Sem pool configurado para esta combinação.',
    })
  }

  // ── Caixas via Mix Final ──
  // MARKETPLACE tem mix próprio (80/15/5 + envelopes) definido em etapa
  // separada. NÃO aplicar o Mix Final B2C aqui.
  if(canalUp==='MARKETPLACE'){
    itens.push({
      insumo:'Caixas (todas)',status:'PENDENTE_ETAPA_MARKETPLACE',
      mensagem:'Marketplace possui mix próprio, definido em etapa separada. Mix Final B2C NÃO foi aplicado.',
      forecast_cd:pedidos,
    })
  }else{
    const mx=mix[`${marca}|${cd}`]
    const epp=cfg.embPorPedido.valor
    if(!mx){
      itens.push({
        insumo:'Caixas (todas)',status:'MIX_NAO_DEFINIDO',
        mensagem:`Mix Final de caixas não cadastrado para ${marca} (${cd}).`,
        forecast_cd:pedidos,
      })
    }else{
      for(const t of TAMANHOS){
        const pct=Number(mx[t.col])
        const ltR=resolveParam(P,[`lead_${t.insumo}`],leadTimeDe(t.insumo))
        const demanda=pedidos*epp*pct
        const e=calcEstoque(demanda,ltR.valor,cfg.diasBase.valor,cfg.fatorSeg.valor,cfg.fatorAlerta.valor)
        const poolCx=poolDe(t.insumo,marca,cd)
        itens.push({
          insumo:t.insumo,status:pct>0?'OK':'MIX_ZERO',
          forecast_cd:pedidos,
          embalagens_por_pedido:epp,
          mix_pct:pct,mix_pct_formatado:`${Math.round(pct*1000)/10}%`,
          unidade:'UN',
          formula:`${pedidos} x ${epp} x ${Math.round(pct*1000)/10}% = ${Math.round(demanda)} un`,
          consumo_projetado:r2(demanda),
          consumo_projetado_arred:Math.round(demanda),
          consumo_dia:e.consumo_dia,
          dias_base:cfg.diasBase.valor,
          lead_time:ltR.valor,lead_time_param:ltR.chave,
          fator_seguranca:cfg.fatorSeg.valor,
          est_min:e.est_min,est_min_arred:e.est_min_arred,
          fator_alerta:cfg.fatorAlerta.valor,
          alerta:e.alerta,alerta_arred:e.alerta_arred,
          // Caixas também são estoque físico compartilhado no CD:
          // cobertura/alerta/compra são avaliados no pool CD+tamanho.
          estoque_compartilhado:true,
          pool:poolCx?poolCx.chave:null,pool_label:poolCx?poolCx.label:null,
          observacao_estoque:poolCx
            ? `Estoque, cobertura, alerta e compra avaliados em ${poolCx.label}.`
            : 'Sem pool configurado para esta combinação.',
        })
      }
    }
  }
  return{itens,bloqueio:null}
}

// Estoque atual por marca|cd|insumo — última submissão B2C de cada combinação.
async function loadEstoqueAtual(db:DB){
  const lat=await db.query(`SELECT s.* FROM submissions s INNER JOIN(SELECT marca,cd,canal,MAX(semana) as max_sem FROM submissions WHERE canal='B2C' AND cd<>'SP' GROUP BY marca,cd,canal) latest ON s.marca=latest.marca AND s.cd=latest.cd AND s.canal=latest.canal AND s.semana=latest.max_sem`,[])
  const map:Record<string,number>={}
  const semanas:Record<string,number>={}
  // Data do snapshot = created_at da submissão. `datas` mantém a precisão de
  // dia (compatibilidade e exibição); `timestamps` guarda o valor completo
  // (data+hora, gravado por datetime('now') no INSERT/INSERT OR REPLACE) e é
  // o que desempata recebimentos confirmados NO MESMO DIA do snapshot — ver
  // estimarEstoqueHoje().
  const datas:Record<string,string>={}
  const timestamps:Record<string,string>={}
  for(const r of lat.rows as any[]){
    for(const[insumo,field] of Object.entries(INSUMO_TO_FIELD))
      map[`${r.marca}|${r.cd}|${insumo}`]=Number(r[field]??0)
    semanas[`${r.marca}|${r.cd}`]=Number(r.semana)
    datas[`${r.marca}|${r.cd}`]=String(r.created_at||'').slice(0,10)
    timestamps[`${r.marca}|${r.cd}`]=String(r.created_at||'')
  }
  return{map,semanas,datas,timestamps}
}

// ── Estoque estimado hoje ────────────────────────────────────────────────────
// Parte do estoque físico do último snapshot de CADA MARCA (que tem data
// própria), desconta o consumo projetado da marca desde então e soma os
// recebimentos confirmados APÓS aquele snapshot — evitando dupla contagem
// quando o snapshot já incorpora a entrada.
//   estimado = MAX(0, snapshot - consumo_dia_marca x dias_decorridos) + recebidos
// Dias decorridos por data civil (o snapshot tem precisão de dia).
function diasEntre(de:string,ate:string){
  const a=new Date(de+'T00:00:00Z').getTime(),b=new Date(ate+'T00:00:00Z').getTime()
  return Math.max(0,Math.round((b-a)/86400000))
}

// ── Corte temporal snapshot × recebimento (v76) ─────────────────────────────
// Um recebimento RECEBIDO conta como "posterior ao snapshot" — e portanto
// deve ser somado ao estoque atual — segundo esta ordem de critérios:
//  1) data_recebimento_real > data_snapshot (dia civil)      -> POSTERIOR
//  2) data_recebimento_real < data_snapshot (dia civil)      -> já refletido
//  3) MESMO dia civil: desempata por timestamp completo.
//       - Se houver confirmado_em (transito_historico.data_alteracao, ver
//         loadRecebimentoConfirmacoes) E timestamp de referência do snapshot
//         (submissions.created_at, sem truncar — ver dataSnapshot/tsSnapshot
//         abaixo para como esse timestamp é escolhido em recebimentos de
//         POOL, sem marca): confirmado_em > tsSnapshot => POSTERIOR.
//         confirmado_em <= tsSnapshot => JÁ REFLETIDO (conservador: assume
//         que o componente mais recente pode já ter contado o recebimento).
//         Nenhum horário é inventado; usam-se apenas timestamps que o
//         próprio sistema já grava.
//       - Se QUALQUER um dos dois timestamps completos não existir (registro
//         legado anterior à tabela transito_historico, ou snapshot sem
//         created_at): NÃO há evidência suficiente para decidir com
//         segurança. Não somamos silenciosamente (isso arriscaria dupla
//         contagem) nem descartamos (perderia a entrada). Resultado:
//         AMBIGUO_MESMO_DIA — fica de fora do estoque calculado e é
//         reportado separadamente para revisão manual.
function recebimentoEPosterior(rec:any,dataSnapshot:string|null,tsSnapshot:string|null)
  :{posterior:boolean;ambiguo:boolean;criterio:string}{
  if(!rec.data_recebimento_real||!dataSnapshot) return{posterior:false,ambiguo:false,criterio:'SEM_DATA'}
  if(rec.data_recebimento_real>dataSnapshot) return{posterior:true,ambiguo:false,criterio:'DATA_POSTERIOR'}
  if(rec.data_recebimento_real<dataSnapshot) return{posterior:false,ambiguo:false,criterio:'DATA_ANTERIOR_JA_REFLETIDO'}
  // Mesmo dia civil.
  if(rec.confirmado_em&&tsSnapshot){
    return rec.confirmado_em>tsSnapshot
      ?{posterior:true,ambiguo:false,criterio:'MESMO_DIA_TIMESTAMP_POSTERIOR'}
      :{posterior:false,ambiguo:false,criterio:'MESMO_DIA_TIMESTAMP_ANTERIOR_JA_REFLETIDO'}
  }
  return{posterior:false,ambiguo:true,criterio:'AMBIGUO_MESMO_DIA_SEM_TIMESTAMP_CONFIAVEL'}
}

function estimarEstoqueHoje(opts:{
  detalheEstoque:{marca:string;estoque:number;data_snapshot:string|null;data_snapshot_ts?:string|null}[]
  consumoDiaPool:number
  participacao:Record<string,number>
  recebidos:any[]
  saidas:any[]
  hoje:string
}){
  const{detalheEstoque,consumoDiaPool,participacao,recebidos,saidas,hoje}=opts
  let estimado=0
  const detalhe:any[]=[]
  // Referência para o corte das SAÍDAS (inalterada nesta versão — fora do
  // escopo desta correção, que trata apenas de recebimentos de pool): o mais
  // ANTIGO snapshot entre os componentes, como já era.
  let dataMaisAntiga:string|null=null
  let tsMaisAntigo:string|null=null
  // ── Referência para RECEBIMENTOS DE POOL (sem marca) — v76.1 ──────────────
  // NÃO usar o snapshot mais antigo (MIN): um recebimento pode ser posterior
  // ao componente mais antigo e ainda assim já estar refletido em outro
  // componente do MESMO pool que foi preenchido depois. Só é seguro somar o
  // recebimento inteiro quando ele é posterior a TODOS os componentes que
  // efetivamente carregam estoque físico deste insumo (estoque>0) — são
  // esses, e só esses, que poderiam "já ter contado" a entrada. Um componente
  // que reportou ZERO não corre esse risco (zero é zero, veio antes ou
  // depois do recebimento) e por isso é ignorado nesta referência — do
  // contrário, marcas que não estocam este insumo (ou não usam este CD)
  // bloqueariam indevidamente a contagem de qualquer recebimento.
  // Se NENHUM componente tem estoque>0, cai no MAIOR (MAX) entre todos —
  // sem risco de dupla contagem (o pool está fisicamente zerado) e ainda
  // assim com um corte temporal definido e auditável.
  let dataRefPoolNaoZero:string|null=null,tsRefPoolNaoZero:string|null=null
  let dataMaxTodos:string|null=null,tsMaxTodos:string|null=null
  for(const e of detalheEstoque){
    const ds=e.data_snapshot
    const dias=ds?diasEntre(ds,hoje):0
    const consumoDiaMarca=consumoDiaPool*(participacao[e.marca]??0)
    const consumido=r2(consumoDiaMarca*dias)
    // Recebimentos confirmados depois do snapshot desta marca — ver
    // recebimentoEPosterior() para o critério completo (inclui empate no
    // mesmo dia civil, desempatado por timestamp). Comparação direta 1:1
    // (marca do recebimento == esta marca) — não sofre a ambiguidade de
    // consolidação de pool tratada abaixo.
    const recebidosApos=recebidos
      .filter(x=>x.data_recebimento_real&&x.data_recebimento_real<=hoje)
      .filter(x=>!x.marca||x.marca===e.marca)
      .filter(x=>recebimentoEPosterior(x,ds,e.data_snapshot_ts??null).posterior)
    const recebidoApos=recebidosApos.reduce((s2,x)=>s2+(Number(x.quantidade_recebida)||0),0)
    const est=Math.max(0,e.estoque-consumido)
    estimado+=est
    detalhe.push({marca:e.marca,estoque_snapshot:e.estoque,data_snapshot:ds,
      dias_decorridos:dias,consumo_dia_marca:r2(consumoDiaMarca),
      consumo_acumulado:consumido,estoque_estimado:r2(est)})
    if(ds&&(!dataMaisAntiga||ds<dataMaisAntiga)){dataMaisAntiga=ds;tsMaisAntigo=e.data_snapshot_ts??null}
    else if(ds&&ds===dataMaisAntiga&&e.data_snapshot_ts&&(!tsMaisAntigo||e.data_snapshot_ts<tsMaisAntigo)) tsMaisAntigo=e.data_snapshot_ts
    if(ds&&(!dataMaxTodos||ds>dataMaxTodos)){dataMaxTodos=ds;tsMaxTodos=e.data_snapshot_ts??null}
    else if(ds&&ds===dataMaxTodos&&e.data_snapshot_ts&&(!tsMaxTodos||e.data_snapshot_ts>tsMaxTodos)) tsMaxTodos=e.data_snapshot_ts
    if(e.estoque>0){
      if(ds&&(!dataRefPoolNaoZero||ds>dataRefPoolNaoZero)){dataRefPoolNaoZero=ds;tsRefPoolNaoZero=e.data_snapshot_ts??null}
      else if(ds&&ds===dataRefPoolNaoZero&&e.data_snapshot_ts&&(!tsRefPoolNaoZero||e.data_snapshot_ts>tsRefPoolNaoZero)) tsRefPoolNaoZero=e.data_snapshot_ts
    }
  }
  const dataRefPool=dataRefPoolNaoZero??dataMaxTodos
  const tsRefPool=dataRefPoolNaoZero!=null?tsRefPoolNaoZero:tsMaxTodos
  // Recebimentos de pool (sem marca) entram uma única vez, avaliados contra
  // dataRefPool/tsRefPool acima — NUNCA contra o snapshot mais antigo.
  const recebidosPoolItens=recebidos
    .filter(x=>!x.marca&&x.data_recebimento_real&&dataRefPool&&x.data_recebimento_real<=hoje)
    .filter(x=>recebimentoEPosterior(x,dataRefPool,tsRefPool).posterior)
  const recebidosPool=recebidosPoolItens.reduce((s2,x)=>s2+(Number(x.quantidade_recebida)||0),0)
  estimado+=recebidosPool
  // Saídas por transferência despachadas APÓS o snapshot. Antes disso, o
  // snapshot físico já reflete a baixa. Previsão vencida não devolve material.
  // ── Corte temporal das saídas ──
  // O SNAPSHOT é a fonte de verdade: tudo que ocorreu ATÉ a data dele já está
  // refletido no número informado pelo operador e não pode ser descontado de
  // novo (dupla baixa). Só entram saídas com data_saida > data_snapshot.
  // Saídas com data FUTURA (> hoje) ainda não ocorreram: não entram aqui,
  // vão para a timeline de projeção como evento negativo.
  // Sem data_saida, usa-se created_at como proxy conservador — nunca se
  // assume baixa anterior ao snapshot.
  const saidasApos=(saidas||[]).filter(x=>{
    const d=x.data_saida||(x.created_at?String(x.created_at).slice(0,10):null)
    if(!d) return true                                  // sem qualquer data: baixa e sinaliza
    if(dataMaisAntiga&&d<=dataMaisAntiga) return false  // já refletido no snapshot
    return d<=hoje                                      // futura fica para a projeção
  })
  const totalSaidas=saidasApos.reduce((s2,x)=>s2+(Number(x.quantidade)||0),0)
  const saidasSemData=saidasApos.filter(x=>!x.data_saida).length
  estimado=Math.max(0,estimado-totalSaidas)
  // Auditoria: todo recebimento RECEBIDO do pool, com o critério usado para
  // incluí-lo ou não no estoque de hoje (ver recebimentoEPosterior). Cobre
  // tanto os de marca quanto os de pool (sem marca), sem duplicar. Para
  // recebimentos de pool, a referência é dataRefPool/tsRefPool (MAX entre os
  // componentes com estoque>0, ou MAX geral se todos forem zero) — nunca o
  // snapshot mais antigo.
  const detalheRecebidos=recebidos
    .filter(x=>x.data_recebimento_real)
    .map(x=>{
      const dsRef=x.marca?(detalheEstoque.find(e=>e.marca===x.marca)?.data_snapshot??null):dataRefPool
      const tsRef=x.marca?(detalheEstoque.find(e=>e.marca===x.marca)?.data_snapshot_ts??null):tsRefPool
      const r=recebimentoEPosterior(x,dsRef,tsRef)
      return{id:x.id,marca:x.marca,quantidade_recebida:x.quantidade_recebida,
        data_recebimento_real:x.data_recebimento_real,confirmado_em:x.confirmado_em??null,
        confianca_timestamp:x.confianca_timestamp??'BAIXA',data_snapshot_referencia:dsRef,
        incluido_no_estoque_hoje:r.posterior,ambiguo:r.ambiguo,criterio:r.criterio,
        observacao:x.observacao}
    })
  // Ambiguidades do mesmo dia: registradas para revisão manual, NUNCA somadas
  // automaticamente ao estoque (ver recebimentoEPosterior — item 2 do pedido
  // de validação: ambiguidade não vira estoque físico confirmado por
  // omissão).
  const ambiguidadesMesmoDia=detalheRecebidos.filter(d=>d.ambiguo)
  return{estoque_estimado_hoje:Math.round(estimado),
    recebido_apos_snapshot:Math.round(recebidosPool),
    detalhe_recebidos:detalheRecebidos,
    ambiguidades_mesmo_dia:ambiguidadesMesmoDia,
    saidas_apos_snapshot:Math.round(totalSaidas),
    saidas_sem_data:saidasSemData,
    detalhe_saidas:saidasApos,
    data_snapshot_mais_antiga:dataMaisAntiga,
    data_referencia_recebido_pool:dataRefPool,detalhe_estimativa:detalhe}
}

// ── Estoque projetado por eventos ────────────────────────────────────────────
// Caminha no tempo: consome até cada chegada confiável, aplica a entrada e
// segue. Nunca soma todas as entradas de uma vez — isso esconderia ruptura
// anterior à chegada. Também devolve a data de ruptura estimada.
// Timeline de saldo. `entradas` aceita quantidades negativas: transferências
// de saída ainda não ocorridas entram como evento negativo na data de saída.
// O estoque projetado é o RESULTADO desta timeline, nunca um componente que
// se subtrai de outro saldo.
function projetarEstoque(inicio:number,consumoDia:number,entradas:{data:string|null;qtd:number}[],hoje:string,ate?:string|null){
  const ord=entradas.filter(e=>e.qtd!==0).map(e=>({...e,dias:e.data?diasEntre(hoje,e.data):0}))
    .sort((a,b)=>a.dias-b.dias)
  let saldo=inicio,diaAnt=0,rupturaDias:number|null=null
  const linha:any[]=[]
  for(const e of ord){
    const consumo=r2(consumoDia*(e.dias-diaAnt))
    const antes=r2(saldo-consumo)
    if(antes<0&&rupturaDias==null&&consumoDia>0) rupturaDias=diaAnt+Math.floor(saldo/consumoDia)
    saldo=r2(Math.max(0,Math.max(0,antes)+e.qtd))
    linha.push({data:e.data,dias:e.dias,consumo_periodo:consumo,
      saldo_antes:antes,entrada:e.qtd,saldo_apos:saldo})
    diaAnt=e.dias
  }
  if(rupturaDias==null&&consumoDia>0){
    const diasRestantes=Math.floor(saldo/consumoDia)
    rupturaDias=diaAnt+diasRestantes
  }
  const dataRuptura=rupturaDias!=null
    ?new Date(new Date(hoje+'T00:00:00Z').getTime()+rupturaDias*86400000).toISOString().slice(0,10)
    :null
  let saldoNaData=saldo
  if(ate){
    const diasAte=diasEntre(hoje,ate)
    saldoNaData=Math.max(0,r2(saldo-consumoDia*Math.max(0,diasAte-diaAnt)))
  }
  return{estoque_projetado:Math.round(saldoNaData),data_projecao:ate??(ord.length?ord[ord.length-1].data:hoje),
    data_ruptura_projetada:dataRuptura,eventos:linha}
}

// ── Data limite para colocar o próximo pedido ────────────────────────────────
// Responde: até quando emitir o pedido para que, respeitando o lead time,
// o material chegue antes da ruptura projetada.
//   data_limite_pedido = data_ruptura_projetada − lead_time
// Calendário: DIAS CORRIDOS. Auditado — o Hub não possui calendário de dias
// úteis nem cadastro de feriados, e o consumo diário deriva de 30,4 dias/mês,
// que também é corrido. Tratar o LT como dias úteis seria inventar convenção.
// Lead time fracionário (FillPack 7,5 d): arredondado PARA CIMA (8 dias), o
// lado conservador — antecipa o pedido em vez de atrasá-lo. Não há suporte a
// horas em nenhum ponto do motor.
// Não há margem de segurança sobre a data: esta é a data-limite matemática.
// (fator_seguranca = 0,5 existe, mas incide sobre o estoque mínimo, não sobre
// prazos, e não foi reaproveitado aqui.)
function calcularDataLimitePedido(dataRuptura:string|null,leadTime:number,hoje:string){
  if(!dataRuptura) return{data_limite_pedido:null,dias_ate_limite_pedido:null,
    status_pedido:'SEM_RUPTURA_NO_HORIZONTE',
    motivo_pedido:'A projeção não encontrou ruptura no horizonte calculado. Sem data de ruptura, não há data-limite a determinar.',
    lead_time_dias_corridos:null}
  const ltDias=Math.ceil(leadTime)
  const limite=new Date(new Date(dataRuptura+'T00:00:00Z').getTime()-ltDias*86400000).toISOString().slice(0,10)
  const dias=Math.round((new Date(limite+'T00:00:00Z').getTime()-new Date(hoje+'T00:00:00Z').getTime())/86400000)
  const status=dias<0?'ATRASADO':dias===0?'PEDIR_HOJE':'NO_PRAZO'
  return{data_limite_pedido:limite,dias_ate_limite_pedido:dias,status_pedido:status,
    lead_time_dias_corridos:ltDias,
    dias_atraso_pedido:dias<0?Math.abs(dias):0,
    motivo_pedido:`ruptura projetada ${dataRuptura} − ${ltDias} dias corridos de lead time`}
}

// ── Camada de confiabilidade da posição operacional (v67, somente leitura) ──
// NÃO participa de nenhum calculo de compra/status/cobertura. Reutiliza os
// mesmos numeros ja calculados (snapshot, dias, consumo estimado, recebido e
// saidas apos snapshot) so para classificar FRESCOR e ORIGEM da variacao —
// distinguindo estimativa de consumo de movimento fisico confirmado (NF de
// recebimento ou transferencia).
type ConfiabilidadeIn={
  estoqueSnapshot:number|null;diasDesdeSnapshot:number|null;
  recebidoAposSnapshot:number;saidasAposSnapshot:number;estoqueOperacionalHoje:number|null}
function calcularConfiabilidadePosicao(o:ConfiabilidadeIn){
  const snap=o.estoqueSnapshot,dias=o.diasDesdeSnapshot,oper=o.estoqueOperacionalHoje
  const rec=o.recebidoAposSnapshot||0,sai=o.saidasAposSnapshot||0
  const consumoEstimado=(snap!=null&&oper!=null)?r2(snap-oper+rec-sai):null
  const pct=(snap!=null&&snap>0&&consumoEstimado!=null)?r2(consumoEstimado/snap*100):null
  const estimativaMaterial=pct!=null&&pct>=20
  const varConfirmada=rec+sai
  let origemVariacao:'CONFIRMADA_POR_MOVIMENTO'|'ESTIMADA_POR_CONSUMO'|'MISTA'|'SEM_ALTERACAO'
  const ce=consumoEstimado??0
  if(varConfirmada>0&&ce>0){
    origemVariacao=varConfirmada>=ce*3?'CONFIRMADA_POR_MOVIMENTO':(ce>=varConfirmada*3?'ESTIMADA_POR_CONSUMO':'MISTA')
  }else if(varConfirmada>0){origemVariacao='CONFIRMADA_POR_MOVIMENTO'}
  else if(ce>0){origemVariacao='ESTIMADA_POR_CONSUMO'}
  else{origemVariacao='SEM_ALTERACAO'}
  let frescorSnapshot:'RECENTE'|'ATENCAO'|'REVISAR'|'DESATUALIZADO'|'SEM_SNAPSHOT'
  if(dias==null) frescorSnapshot='SEM_SNAPSHOT'
  else if(dias<=2) frescorSnapshot='RECENTE'
  else if(dias<=5) frescorSnapshot='ATENCAO'
  else if(dias<=7) frescorSnapshot='REVISAR'
  else frescorSnapshot='DESATUALIZADO'
  // Ancorado: a variacao confirmada por movimento fisico (recebimento/transferencia)
  // e igual ou maior que a parcela estimada — a posicao nao depende so de projecao.
  const ancorado=varConfirmada>0&&(origemVariacao==='CONFIRMADA_POR_MOVIMENTO'||origemVariacao==='MISTA')&&varConfirmada>=ce
  let confiabilidadePosicao:'ALTA'|'MEDIA'|'BAIXA'
  if(dias!=null&&dias<=2) confiabilidadePosicao='ALTA'
  else if(ancorado&&(dias==null||dias<=5)) confiabilidadePosicao='ALTA'
  else if(dias!=null&&dias<=5&&!estimativaMaterial) confiabilidadePosicao='MEDIA'
  else if((dias!=null&&dias>5)||estimativaMaterial) confiabilidadePosicao=ancorado?'MEDIA':'BAIXA'
  else confiabilidadePosicao='MEDIA'
  const revisaoRecomendada=confiabilidadePosicao==='BAIXA'||(dias!=null&&dias>7)
  return{consumo_estimado_desde_snapshot:consumoEstimado,
    pct_consumo_estimado_sobre_snapshot:pct,
    estimativa_material:estimativaMaterial,
    origem_variacao:origemVariacao,
    frescor_snapshot:frescorSnapshot,
    confiabilidade_posicao:confiabilidadePosicao,
    revisao_recomendada:revisaoRecomendada}
}

// Consolidação dos pools de FillPack e Fita Gomada por CD.
// Consumo do pool = soma do consumo projetado das marcas do pool.
// Estoque do pool = soma dos estoques reportados pelas marcas do pool.
function consolidarPools(
  combos:{marca:string;cd:string;canal:string;itens:any[]}[],
  estoque:Record<string,number>,
  cfg:any,P:Params,
  transito:any={porPool:{}},
  datasSnapshot:Record<string,string>={},
  timestampsSnapshot:Record<string,string>={}
){
  const hoje=transito.hoje||new Date().toISOString().slice(0,10)
  const out:any[]=[]
  for(const pool of POOLS){
    const marcasComConsumo=combos.filter(g=>g.cd===pool.cd&&String(g.canal).toUpperCase()==='B2C'&&pool.marcas.includes(g.marca))
    if(!marcasComConsumo.length) continue
    let consumoMes=0
    const detalhe:any[]=[]
    for(const g of marcasComConsumo){
      const it=g.itens.find(i=>i.insumo===pool.insumo&&i.consumo_projetado!=null)
      if(!it) continue
      consumoMes+=Number(it.consumo_projetado)
      detalhe.push({marca:g.marca,consumo_projetado:it.consumo_projetado,coeficiente:it.coeficiente})
    }
    if(!detalhe.length) continue
    const ltR=resolveParam(P,[`lead_${pool.insumo}`],leadTimeDe(pool.insumo))
    const consumoDia=consumoMes/cfg.diasBase.valor
    // Estoque físico do pool: soma do que cada marca do pool reportou.
    let estoquePool:number|null=null
    const estoqueDetalhe:any[]=[]
    for(const m of pool.marcas){
      const v=estoque[`${m}|${pool.cd}|${pool.insumo}`]
      if(v==null) continue
      estoquePool=(estoquePool??0)+v
      estoqueDetalhe.push({marca:m,estoque:v,data_snapshot:datasSnapshot[`${m}|${pool.cd}`]??null,
        data_snapshot_ts:timestampsSnapshot[`${m}|${pool.cd}`]??null})
    }
    const estMin=consumoDia*ltR.valor*(1+cfg.fatorSeg.valor)
    const tr=transito.porPool[pool.chave]
    const rep=avaliarReposicao({
      consumoMes,consumoDia,leadTime:ltR.valor,metaMeses:cfg.metaMeses.valor,
      estoque:estoquePool,transito:tr?tr.qtd:0,data_prevista:tr?tr.data:null,
      estoqueMinimo:estMin,
      entradas:tr?tr.itens.map((i:any)=>({quantidade:i.quantidade,data_prevista:i.data_prevista})):[],
    })
    // ── Estoque estimado hoje e projeção por eventos ──
    const participacao:Record<string,number>={}
    for(const d of detalhe) participacao[d.marca]=consumoMes>0?d.consumo_projetado/consumoMes:0
    const saidasPool=(transito.saidasPorPool||{})[pool.chave]
    const est=estimarEstoqueHoje({detalheEstoque:estoqueDetalhe,consumoDiaPool:consumoDia,
      participacao,recebidos:tr?tr.recebidos:[],saidas:saidasPool?saidasPool.itens:[],hoje})
    const estimadoHoje=estoquePool==null?null:est.estoque_estimado_hoje
    const coberturaEstimada=(estimadoHoje!=null&&consumoDia>0)?r2(estimadoHoje/consumoDia):null
    // Só entradas EM_TRANSITO alimentam a projeção. PREVISAO_VENCIDA fica fora.
    const entradasConfiaveis=tr?tr.itens.map((i:any)=>({data:i.data_prevista,qtd:i.quantidade})):[]
    // Saídas ainda não ocorridas (data futura) reduzem o saldo na data de saída.
    const saidasFuturas=(saidasPool?saidasPool.itens:[])
      .filter((x:any)=>x.data_saida&&x.data_saida>hoje)
      .map((x:any)=>({data:x.data_saida,qtd:-Number(x.quantidade||0)}))
    const eventos=[...entradasConfiaveis,...saidasFuturas]
    const proj=estimadoHoje==null?null:projetarEstoque(estimadoHoje,consumoDia,eventos,hoje)
    // Prioridade pela margem sobre o lead time, usando a cobertura estimada.
    const lim=calcularDataLimitePedido(proj?proj.data_ruptura_projetada:null,ltR.valor,hoje)
    // Confiabilidade: movimentações sem data de saída ou com origem a apurar
    // podem deslocar a projeção — e portanto a data-limite.
    const pendMov=(est.saidas_sem_data||0)>0
    const margemLT=coberturaEstimada!=null?r2(coberturaEstimada-ltR.valor):null
    const prioridade=margemLT==null?'SEM_ESTOQUE'
      :margemLT<0?'URGENTE':margemLT<=ltR.valor*0.3?'ATENCAO':'NORMAL'

    // ── Posição operacional de HOJE: fonte oficial do risco imediato ────────
    // Reutiliza classificarPool — MESMA regra e MESMOS thresholds do Status
    // vigente — trocando apenas a BASE: em vez do snapshot puro, usa a posição
    // operacional já calculada por estimarEstoqueHoje:
    //   snapshot - consumo posterior + recebimentos posteriores - saidas posteriores
    // com corte temporal estrito (movimento <= snapshot ja esta refletido nele).
    // Nao existe formula nova: mesma funcao de posicao, mesma funcao de
    // classificacao. A base da Sugestao de Compra (snapshot) fica intacta.
    const clsOp=classificarPool({estoque:estimadoHoje,consumoDia,leadTime:ltR.valor,
      estoqueMinimo:estMin,
      entradas:tr?tr.itens.map((i:any)=>({quantidade:i.quantidade,data_prevista:i.data_prevista})):[]})

    // ── Base oficial da NECESSIDADE DE COMPRA: posicao operacional de hoje ──
    // Reutiliza avaliarReposicao — MESMA funcao, mesmas metas, mesmo desconto
    // de transito — trocando apenas a BASE DE ESTOQUE: snapshot -> posicao
    // operacional ja calculada por estimarEstoqueHoje. Nao ha segunda
    // reconstrucao de estoque nem formula paralela.
    // RECEBIDO posterior ao snapshot ja esta DENTRO de estimadoHoje; o transito
    // descontado aqui e apenas tr.qtd, que por construcao (loadTransito) contem
    // somente EM_TRANSITO — RECEBIDO e PREVISAO_VENCIDA ficam de fora. Logo o
    // recebimento entra uma unica vez e nao sofre duplo desconto. Saidas
    // posteriores ao snapshot ja foram abatidas na posicao operacional e nao
    // sao subtraidas de novo aqui.
    const estoqueBaseCompra=estimadoHoje!=null?estimadoHoje:estoquePool
    const repOp=avaliarReposicao({
      consumoMes,consumoDia,leadTime:ltR.valor,metaMeses:cfg.metaMeses.valor,
      estoque:estoqueBaseCompra,transito:tr?tr.qtd:0,data_prevista:tr?tr.data:null,
      estoqueMinimo:estMin,
      entradas:tr?tr.itens.map((i:any)=>({quantidade:i.quantidade,data_prevista:i.data_prevista})):[]})

    out.push({
      pool:pool.chave,label:pool.label,insumo:pool.insumo,cd:pool.cd,
      marcas:pool.marcas,compartilhavel:pool.chave!=='FITA_RITUARIA_ES',
      unidade:pool.unidade,
      consumo_mensal:r2(consumoMes),consumo_dia:r2(consumoDia),
      lead_time:ltR.valor,lead_time_param:ltR.chave,
      est_min:Math.round(estMin),
      detalhe_consumo:detalhe,detalhe_estoque:estoqueDetalhe,
      detalhe_transito:tr?tr.itens:[],
      // ── Nomenclatura explícita das três posições de estoque ──
      estoque_snapshot:estoquePool,
      data_snapshot:est.data_snapshot_mais_antiga,
      dias_desde_snapshot:est.data_snapshot_mais_antiga?diasEntre(est.data_snapshot_mais_antiga,hoje):null,
      // ── Camada de confiabilidade (v67) — somente leitura, nao usada em nenhum calculo ──
      ...calcularConfiabilidadePosicao({
        estoqueSnapshot:estoquePool,
        diasDesdeSnapshot:est.data_snapshot_mais_antiga?diasEntre(est.data_snapshot_mais_antiga,hoje):null,
        recebidoAposSnapshot:est.recebido_apos_snapshot,
        saidasAposSnapshot:est.saidas_apos_snapshot,
        estoqueOperacionalHoje:estimadoHoje}),
      estoque_estimado_hoje:estimadoHoje,
      cobertura_estimada_hoje:coberturaEstimada,
      recebido_apos_snapshot:est.recebido_apos_snapshot,
      detalhe_recebidos:est.detalhe_recebidos,
      ambiguidades_mesmo_dia:est.ambiguidades_mesmo_dia,
      saidas_apos_snapshot:est.saidas_apos_snapshot,
      saidas_sem_data:est.saidas_sem_data,
      detalhe_saidas:est.detalhe_saidas,
      detalhe_estimativa:est.detalhe_estimativa,
      estoque_projetado_futuro:proj?proj.estoque_projetado:null,
      data_projecao:proj?proj.data_projecao:null,
      data_ruptura_projetada:proj?proj.data_ruptura_projetada:null,
      eventos_projecao:proj?proj.eventos:[],
      transito_confiavel:tr?tr.qtd:0,
      transito_vencido:tr?tr.qtd_vencida:0,
      detalhe_transito_vencido:tr?tr.itens_vencidos:[],
      recebidos:tr?tr.recebidos:[],
      margem_lt:margemLT,prioridade,
      ...lim,
      // Bases declaradas: Status e Próximo pedido medem coisas diferentes.
      base_status:'Estoque do último snapshot + simulação cronológica das entradas confiáveis, comparado a consumo do lead time e estoque mínimo. Mede a situação operacional.',
      base_proximo_pedido:'Estoque estimado hoje + timeline de entradas e saídas futuras -> data de ruptura -> menos lead time. Mede o prazo para emitir a OC.',
      saidas_futuras:saidasFuturas.length,
      projecao_confiavel:!pendMov,
      alerta_projecao:pendMov
        ?'PROJEÇÃO COM PENDÊNCIA DE MOVIMENTAÇÃO: há transferência sem data de saída informada. A data-limite pode mudar após a reconciliação.'
        :null,
      observacao:'Estoque do pool = soma do que cada marca reportou no formulário. Se as marcas reportam o MESMO estoque físico, há risco de dupla contagem — validar antes de comprar.',
      ...rep,
      // ── Risco operacional de HOJE — sobrepoe o alias baseado em snapshot ──
      // estoque_atual, estoque_alvo, gap_para_meta e compra_sugerida seguem
      // vindo de ...rep sobre o SNAPSHOT: a Sugestao de Compra nao muda aqui.
      estoque_operacional_hoje:estimadoHoje,
      cobertura_operacional_dias:coberturaEstimada,
      status_operacional:clsOp.status,
      // Historico preservado para auditoria — nada e apagado.
      status_snapshot:rep.status,
      cobertura_dias_snapshot:rep.cobertura_dias,
      estoque_pos_chegada_operacional:clsOp.estoque_pos_chegada,
      ruptura_antes_da_chegada_operacional:clsOp.ruptura_antes_da_chegada,
      cobertura_dias:coberturaEstimada,
      status:clsOp.status,
      base_status:'Posicao operacional de hoje (snapshot + recebimentos confirmados posteriores - consumo posterior - saidas posteriores) + simulacao cronologica das entradas confiaveis, comparada ao consumo do lead time e ao estoque minimo. Mede o risco imediato.',
      // ── Necessidade de compra sobre a posicao operacional (v66) ──────────
      // estoque_alvo, meta_meses e consumo permanecem os mesmos de ...rep.
      estoque_base_compra:estoqueBaseCompra,
      base_calculo_compra:'ESTOQUE_OPERACIONAL_HOJE',
      gap_para_meta:repOp.gap_para_meta,
      necessidade:repOp.necessidade,
      estoque_projetado:repOp.estoque_projetado,
      compra_sugerida:repOp.compra_sugerida,
      regra_compra:'MAX(0, MAX(0, alvo - estoque operacional de hoje) - transito confiavel)',
      // Base antiga preservada para auditoria — nada e apagado.
      gap_para_meta_snapshot:rep.gap_para_meta,
      compra_sugerida_snapshot:rep.compra_sugerida,
      base_compra_sugerida:'Posicao operacional de hoje (snapshot + recebimentos confirmados posteriores - consumo posterior - saidas posteriores), menos o transito confiavel. RECEBIDO entra apenas via posicao operacional; EM_TRANSITO apenas como desconto; PREVISAO_VENCIDA nao reduz.',
    })
  }
  return out
}

// ── Posição física para CD/insumo SEM pool de planejamento (v70) ────────────
// Função pura, reutilizada por GET /api/transito (leitura informativa) e por
// POST /api/transferencias (validação de origem). Única fórmula — sem
// duplicação. Regra temporal idêntica à já usada para pools com planejamento
// (saidasPorPool em loadTransito): a saída da origem é aplicada assim que
// data_saida ocorreu, INDEPENDENTE do status no destino (EM_TRANSITO ou
// RECEBIDO) — o material já saiu fisicamente da origem nesse momento.
// A entrada no destino só conta quando RECEBIDO (EM_TRANSITO não é estoque
// disponível ainda).
function calcularPosicaoFisicaSemPool(rows:any[],hoje:string){
  const map:Record<string,{cd:string;insumo:string;recebido_total:number;despachado_total:number;posicao_fisica:number}>={}
  const ensure=(cd:string,insumo:string)=>{
    const k=`${cd}|${insumo}`
    if(!map[k]) map[k]={cd,insumo,recebido_total:0,despachado_total:0,posicao_fisica:0}
    return map[k]
  }
  for(const r of rows){
    const status=r.status||'EM_TRANSITO'
    if(status==='RECEBIDO'&&!POOLS.some(p=>p.insumo===r.insumo&&p.cd===r.cd)){
      ensure(r.cd,r.insumo).recebido_total+=Number(r.quantidade_recebida??r.quantidade)||0
    }
    if(r.tipo_movimentacao==='TRANSFERENCIA_CD'&&r.cd_origem&&r.data_saida&&r.data_saida<=hoje
       &&!POOLS.some(p=>p.insumo===r.insumo&&p.cd===r.cd_origem)){
      ensure(r.cd_origem,r.insumo).despachado_total+=Number(r.quantidade)||0
    }
  }
  for(const k in map) map[k].posicao_fisica=r2(map[k].recebido_total-map[k].despachado_total)
  return map
}

// Timestamp confiável de QUANDO um registro foi marcado RECEBIDO no sistema.
// Fonte: transito_historico.data_alteracao (datetime('now'), gravado no
// exato momento do PATCH /api/transito/:id/status e nunca reescrito depois —
// ver comentário na criação da tabela). NÃO usar compras_em_transito.updated_at
// para isso: esse campo é tocado por QUALQUER edição do registro (PUT, PATCH
// .../movimentacao), inclusive muito depois do recebimento, e deixaria de
// refletir o momento real da confirmação.
// Quando o mesmo transito_id tem mais de uma transição para RECEBIDO
// (voltou e foi recebido de novo), usa-se a mais recente (MAX).
async function loadRecebimentoConfirmacoes(db:DB){
  const rows=(await db.query(
    `SELECT transito_id, MAX(data_alteracao) as confirmado_em FROM transito_historico WHERE status_novo='RECEBIDO' GROUP BY transito_id`,[]
  )).rows as any[]
  const map:Record<number,string>={}
  for(const r of rows) map[Number(r.transito_id)]=String(r.confirmado_em)
  return map
}

// Carrega o estoque em trânsito agregado por pool físico.
// Uma linha casa com o pool quando o campo `pool` bate com a chave OU
// quando marca+cd+insumo pertencem ao pool. Datas: a mais próxima.
async function loadTransito(db:DB,hoje=new Date().toISOString().slice(0,10)){
  const rows=(await db.query('SELECT * FROM compras_em_transito WHERE ativo=1',[])).rows as any[]
  const confirmacoes=await loadRecebimentoConfirmacoes(db)
  // Só entradas EM_TRANSITO são confiáveis. PREVISAO_VENCIDA fica de fora da
  // projeção e da compra; RECEBIDO deixa de ser trânsito e vira estoque.
  const porPool:Record<string,{qtd:number;data:string|null;itens:any[];
    qtd_vencida:number;itens_vencidos:any[];recebidos:any[]}>={}
  // Saídas por pool de ORIGEM: transferências já despachadas.
  const saidasPorPool:Record<string,{qtd:number;itens:any[]}>={}
  for(const r of rows){
    r.status=r.status||'EM_TRANSITO'
    r.tipo_movimentacao=r.tipo_movimentacao||'COMPRA_FORNECEDOR'
    // Baixa na origem: vale para qualquer status, pois o material já saiu.
    if(r.tipo_movimentacao==='TRANSFERENCIA_CD'&&r.cd_origem){
      const origem=POOLS.find(p=>p.insumo===r.insumo&&p.cd===r.cd_origem)
      if(origem){
        const so=saidasPorPool[origem.chave]||{qtd:0,itens:[]}
        so.qtd+=Number(r.quantidade||0)
        so.itens.push({id:r.id,insumo:r.insumo,quantidade:Number(r.quantidade),
          cd_origem:r.cd_origem,cd_destino:r.cd,data_saida:r.data_saida,
          data_saida_status:r.data_saida?'INFORMADA':'DATA_SAIDA_PENDENTE',
          created_at:r.created_at,
          status:r.status,observacao:r.observacao})
        saidasPorPool[origem.chave]=so
      }
    }
    r.previsao_vencida_flag=r.status==='EM_TRANSITO'&&!!r.data_prevista&&r.data_prevista<hoje
    r.quantidade_efetiva=r.status==='RECEBIDO'
      ?Number(r.quantidade_recebida??r.quantidade)
      :Number(r.quantidade)
    const alvos=POOLS.filter(p=>{
      if(r.pool) return p.chave===r.pool
      if(p.insumo!==r.insumo||p.cd!==r.cd) return false
      return r.marca?p.marcas.includes(r.marca):true
    })
    for(const p of alvos){
      const cur=porPool[p.chave]||{qtd:0,data:null,itens:[],qtd_vencida:0,itens_vencidos:[],recebidos:[]}
      const base={id:r.id,marca:r.marca,quantidade:Number(r.quantidade),unidade:r.unidade,
        data_prevista:r.data_prevista,observacao:r.observacao,status:r.status,
        pedido_oc:r.pedido_oc,previsao_vencida_flag:r.previsao_vencida_flag}
      if(r.status==='RECEBIDO'){
        cur.recebidos.push({...base,quantidade_recebida:r.quantidade_efetiva,
          data_recebimento_real:r.data_recebimento_real,
          confirmado_em:confirmacoes[Number(r.id)]??null,
          confianca_timestamp:confirmacoes[Number(r.id)]?'ALTA':'BAIXA'})
      }else if(r.status==='PREVISAO_VENCIDA'){
        cur.qtd_vencida+=Number(r.quantidade||0)
        cur.itens_vencidos.push(base)
      }else{
        cur.qtd+=Number(r.quantidade||0)
        if(r.data_prevista&&(!cur.data||r.data_prevista<cur.data)) cur.data=r.data_prevista
        cur.itens.push(base)
      }
      porPool[p.chave]=cur
    }
  }
  return{rows,porPool,saidasPorPool,hoje}
}

// ── CRUD do estoque em trânsito ───────────────────────────────────────────────
app.get('/api/transito',async c=>{
  await initDb(c.env.DB)
  const q=c.req.query()
  let sql='SELECT * FROM compras_em_transito WHERE ativo=1';const p:unknown[]=[]
  if(q.cd){sql+=' AND cd=?';p.push(q.cd)}
  if(q.insumo){sql+=' AND insumo=?';p.push(q.insumo)}
  if(q.pool){sql+=' AND pool=?';p.push(q.pool)}
  if(q.status){sql+=' AND COALESCE(status,\'EM_TRANSITO\')=?';p.push(String(q.status).toUpperCase())}
  sql+=' ORDER BY data_prevista,cd,insumo'
  const rows=(await c.env.DB.query(sql,p)).rows as any[]
  const hoje=new Date().toISOString().slice(0,10)
  const enriquecidas=rows.map(r=>{
    const status=r.status||'EM_TRANSITO'
    const vencida=status==='EM_TRANSITO'&&!!r.data_prevista&&r.data_prevista<hoje
    return{...r,status,
      tipo_movimentacao:r.tipo_movimentacao||'COMPRA_FORNECEDOR',
      data_saida_status:(r.tipo_movimentacao==='TRANSFERENCIA_CD')
        ?(r.data_saida?'INFORMADA':'DATA_SAIDA_PENDENTE'):null,
      previsao_vencida:vencida,
      dias_atraso:vencida?diasEntre(r.data_prevista,hoje):0,
      // Alerta visual apenas. A mudança de status continua sendo manual.
      alerta:vencida?'⚠ PREVISÃO DE CHEGADA VENCIDA':null,
      sugestao_status:vencida?'PREVISAO_VENCIDA':null,
      quantidade_pendente:status==='RECEBIDO'
        ?Math.max(0,Number(r.quantidade)-Number(r.quantidade_recebida??r.quantidade)):null}
  })
  const{porPool}=await loadTransito(c.env.DB)
  const cont=(st:string)=>enriquecidas.filter(x=>x.status===st).length
  // v70: mesma função usada na validação de POST /api/transferencias — fonte única.
  // O ledger precisa ser GLOBAL (um despacho pode ter cd_origem fora do filtro
  // ?cd=/?insumo= aplicado à listagem) — reaproveita `rows` só quando nenhum
  // filtro foi passado; caso contrário busca sem filtro apenas para o ledger.
  const rowsLedger=(q.cd||q.insumo||q.pool||q.status)
    ?(await c.env.DB.query('SELECT * FROM compras_em_transito WHERE ativo=1',[])).rows as any[]
    :rows
  const posicaoFisicaSemPool=calcularPosicaoFisicaSemPool(rowsLedger,hoje)

  return c.json({transito:enriquecidas,por_pool:porPool,hoje,
    status_disponiveis:STATUS_TRANSITO,
    tipos_movimentacao:TIPOS_MOVIMENTACAO,
    resumo:{EM_TRANSITO:cont('EM_TRANSITO'),PREVISAO_VENCIDA:cont('PREVISAO_VENCIDA'),
      RECEBIDO:cont('RECEBIDO'),previsao_vencida_nao_confirmada:enriquecidas.filter(x=>x.previsao_vencida).length},
    regra:{EM_TRANSITO:'entrada confiável: entra na projeção e reduz a compra sugerida',
      PREVISAO_VENCIDA:'não confiável: fica fora da projeção e da compra sugerida, e não mascara risco',
      RECEBIDO:'sai do trânsito; entra no estoque estimado apenas se recebido após o snapshot'},
    posicao_fisica_sem_pool:{
      valores:Object.values(posicaoFisicaSemPool),
      observacao:'Posição física informativa para CD/insumo sem pool de planejamento (ex.: SP/MG). Não gera Forecast, estoque mínimo, status nem Sugestão de Compra.'}})
})

// Transferência entre CDs. Cria um único registro com origem e destino:
// baixa a origem na data de saída e credita o destino só quando RECEBIDO.
app.post('/api/transferencias',async c=>{
  await initDb(c.env.DB)
  let b:any;try{b=await c.req.json()}catch{return c.json({error:'Invalid JSON'},400)}
  const cdOrigem=String(b.cd_origem||'').trim().toUpperCase()
  const cdDestino=String(b.cd_destino||'').trim().toUpperCase()
  const insumo=String(b.insumo||'').trim()
  const qtd=Number(b.quantidade)
  if(!cdOrigem||!cdDestino||!insumo||isNaN(qtd)||qtd<=0)
    return c.json({error:'Obrigatório: cd_origem, cd_destino, insumo, quantidade (>0)'},400)
  if(cdOrigem===cdDestino) return c.json({error:'Origem e destino não podem ser o mesmo CD'},400)
  // ── v69: transferência é MOVIMENTAÇÃO FÍSICA, não planejamento ──────────
  // A validação correta é "CD válido", não "existe pool de planejamento".
  // Um pool de planejamento (Forecast/consumo/mínimo/compra) pode não existir
  // ainda no destino (ex.: SP/MG antes da distribuição de Marketplace) sem
  // que isso impeça o registro logístico do movimento físico.
  const CDS=CDS_OFICIAIS as readonly string[]
  if(!CDS.includes(cdOrigem)) return c.json({error:`CD origem inválido: ${cdOrigem}. Válidos: ${CDS.join(', ')}`},400)
  if(!CDS.includes(cdDestino)) return c.json({error:`CD destino inválido: ${cdDestino}. Válidos: ${CDS.join(', ')}`},400)
  // data_saida é desejável, não bloqueante: a saída física já ocorreu.
  // Sem ela o registro fica DATA_SAIDA_PENDENTE e a baixa é aplicada.
  const dataSaida=b.data_saida||null
  // Pool de planejamento é OPCIONAL — usado apenas se já existir, para que a
  // origem/destino continuem casando com a posição operacional do pool
  // quando ele existir (ex.: ES/RJ, hoje). Sem pool (ex.: SP/MG), a coluna
  // fica NULL: o movimento é preservado, mas não alimenta Forecast, estoque
  // mínimo, status nem Sugestão de Compra — nenhum pool falso é criado.
  const poolDestino=POOLS.find(p=>p.insumo===insumo&&p.cd===cdDestino)??null
  const unidade=b.unidade||(insumo.startsWith('Caixa')?'UN':'BOBINA')

  // ── v70: guarda de segurança — não permitir transferir acima do estoque
  // físico disponível na origem. Reutiliza as MESMAS fontes já validadas:
  //   • origem COM pool de planejamento (ES/RJ hoje): estoque_operacional_hoje,
  //     calculado por poolStatusAtual() — a mesma função usada em
  //     GET /api/pools/status. Nenhuma fórmula paralela.
  //   • origem SEM pool de planejamento (SP/MG hoje): calcularPosicaoFisicaSemPool(),
  //     a mesma função usada em GET /api/transito.posicao_fisica_sem_pool.
  // EM_TRANSITO de entrada para a origem NUNCA conta como disponível — só
  // RECEBIDO (posição operacional) ou o ledger físico (que só soma RECEBIDO).
  const poolOrigem=POOLS.find(p=>p.insumo===insumo&&p.cd===cdOrigem)??null
  let disponivelOrigem:number|null=null
  if(poolOrigem){
    const statusPools=await poolStatusAtual(c.env.DB)
    const po=(statusPools as any)[poolOrigem.chave]
    disponivelOrigem=po?(po.estoque_operacional_hoje??null):null
  }else{
    const rowsOrigem=(await c.env.DB.query('SELECT * FROM compras_em_transito WHERE ativo=1',[])).rows as any[]
    const hojeVal=new Date().toISOString().slice(0,10)
    const ledger=calcularPosicaoFisicaSemPool(rowsOrigem,hojeVal)
    const entry=ledger[`${cdOrigem}|${insumo}`]
    disponivelOrigem=entry?entry.posicao_fisica:0
  }
  if(disponivelOrigem==null)
    return c.json({error:`Não foi possível determinar a posição física disponível em ${cdOrigem} para ${insumo}. Transferência bloqueada por segurança — verifique se há snapshot/movimentação suficiente para calcular a posição operacional.`},400)
  if(qtd>disponivelOrigem)
    return c.json({error:`Estoque físico insuficiente em ${cdOrigem} para ${insumo}. Disponível: ${fmt(disponivelOrigem)} ${unidade}. Transferência solicitada: ${fmt(qtd)} ${unidade}.`},400)

  await c.env.DB.exec(`INSERT INTO compras_em_transito(cd,marca,pool,canal,insumo,quantidade,unidade,data_prevista,observacao,tipo_movimentacao,cd_origem,data_saida,pedido_oc) VALUES(?,?,?,?,?,?,?,?,?,'TRANSFERENCIA_CD',?,?,?)`,
    [cdDestino,null,poolDestino?poolDestino.chave:null,String(b.canal||'B2C').toUpperCase(),insumo,qtd,
     unidade,b.previsao_chegada||b.data_prevista||null,
     b.observacao||null,cdOrigem,dataSaida,b.pedido_oc||null])
  const nr=await c.env.DB.query('SELECT * FROM compras_em_transito ORDER BY id DESC LIMIT 1',[])
  return c.json({ok:true,action:'transferencia_criada',
    data_saida_status:dataSaida?'INFORMADA':'DATA_SAIDA_PENDENTE',
    disponivel_origem_antes:disponivelOrigem,
    efeito:{origem:`${cdOrigem}: baixa de ${qtd}${dataSaida?` em ${dataSaida}`:' (data de saída pendente de informação)'}`,
      destino:`${cdDestino}: entra como EM_TRANSITO; vira estoque só quando RECEBIDO`},
    planejamento_destino:poolDestino
      ?{pool:poolDestino.chave,mensagem:'Destino possui pool de planejamento — a posição operacional será atualizada normalmente quando RECEBIDO.'}
      :{pool:null,mensagem:`${cdDestino} ainda não possui pool de planejamento para ${insumo}. O movimento físico foi registrado normalmente; nenhum Forecast, estoque mínimo, status ou Sugestão de Compra foi gerado a partir dele.`},
    transferencia:nr.rows[0]})
})

app.post('/api/transito',async c=>{
  await initDb(c.env.DB)
  let b:any;try{b=await c.req.json()}catch{return c.json({error:'Invalid JSON'},400)}
  const cd=String(b.cd||'').trim()
  const insumo=String(b.insumo||'').trim()
  const qtd=Number(b.quantidade)
  if(!cd||!insumo||isNaN(qtd)||qtd<0) return c.json({error:'Obrigatório: cd, insumo, quantidade (>=0)'},400)
  const marca=b.marca?normMarca(String(b.marca)):null
  const pool=b.pool?String(b.pool):null
  if(pool&&!POOLS.some(p=>p.chave===pool)) return c.json({error:`Pool inexistente: ${pool}`,pools:POOLS.map(p=>p.chave)},400)
  const tipo=String(b.tipo_movimentacao||'COMPRA_FORNECEDOR').toUpperCase()
  if(!TIPOS_MOVIMENTACAO.includes(tipo as any)) return c.json({error:`tipo_movimentacao inválido. Use: ${TIPOS_MOVIMENTACAO.join(', ')}`},400)
  if(tipo==='TRANSFERENCIA_CD'&&(!b.cd_origem||!b.data_saida))
    return c.json({error:'Transferência exige cd_origem e data_saida. Prefira POST /api/transferencias.'},400)
  await c.env.DB.exec(`INSERT INTO compras_em_transito(cd,marca,pool,canal,insumo,quantidade,unidade,data_prevista,observacao,tipo_movimentacao,cd_origem,data_saida,pedido_oc) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [cd,marca,pool,String(b.canal||'B2C').toUpperCase(),insumo,qtd,
     b.unidade||(insumo.startsWith('Caixa')?'UN':'BOBINA'),b.data_prevista||null,b.observacao||null,
     tipo,b.cd_origem?String(b.cd_origem).toUpperCase():null,b.data_saida||null,b.pedido_oc||null])
  const nr=await c.env.DB.query('SELECT * FROM compras_em_transito WHERE ativo=1 ORDER BY id DESC LIMIT 1',[])
  return c.json({ok:true,action:'created',transito:nr.rows[0]})
})

// Alteração MANUAL de status. O usuário é a autoridade: o sistema sugere,
// nunca muda sozinho. Toda troca fica registrada em transito_historico.
app.patch('/api/transito/:id/status',async c=>{
  await initDb(c.env.DB)
  const id=Number(c.req.param('id'))
  if(isNaN(id)) return c.json({error:'ID inválido'},400)
  let b:any;try{b=await c.req.json()}catch{return c.json({error:'Invalid JSON'},400)}
  const novo=String(b.status||'').toUpperCase()
  if(!STATUS_TRANSITO.includes(novo as any))
    return c.json({error:`Status inválido. Use: ${STATUS_TRANSITO.join(', ')}`},400)
  const ex=await c.env.DB.query('SELECT * FROM compras_em_transito WHERE id=? AND ativo=1',[id])
  if(!ex.rows.length) return c.json({error:'Registro não encontrado'},404)
  const cur=ex.rows[0] as any
  const anterior=cur.status||'EM_TRANSITO'

  let dataReceb=cur.data_recebimento_real,qtdReceb=cur.quantidade_recebida
  if(novo==='RECEBIDO'){
    dataReceb=b.data_recebimento_real||cur.data_recebimento_real||new Date().toISOString().slice(0,10)
    // Sem quantidade informada, assume recebimento integral do pedido.
    qtdReceb=b.quantidade_recebida!=null?Number(b.quantidade_recebida):Number(cur.quantidade)
    if(isNaN(qtdReceb)||qtdReceb<0) return c.json({error:'quantidade_recebida inválida'},400)
  }else{
    // Voltar de RECEBIDO limpa os campos de recebimento, sem apagar o pedido.
    if(anterior==='RECEBIDO'){dataReceb=null;qtdReceb=null}
  }
  await c.env.DB.exec(`UPDATE compras_em_transito SET status=?,data_recebimento_real=?,quantidade_recebida=?,updated_at=datetime('now') WHERE id=?`,
    [novo,dataReceb,qtdReceb,id])
  await c.env.DB.exec(`INSERT INTO transito_historico(transito_id,status_anterior,status_novo,quantidade_recebida,data_recebimento_real,autor,observacao) VALUES(?,?,?,?,?,?,?)`,
    [id,anterior,novo,qtdReceb,dataReceb,b.autor||null,b.observacao||null])
  const nr=await c.env.DB.query('SELECT * FROM compras_em_transito WHERE id=?',[id])
  const pendente=novo==='RECEBIDO'?Math.max(0,Number(cur.quantidade)-Number(qtdReceb||0)):null
  return c.json({ok:true,action:'status_alterado',status_anterior:anterior,status_novo:novo,
    quantidade_pendente:pendente,
    aviso:pendente?`Recebimento parcial: ${pendente} ${cur.unidade} ainda não recebidos. O registro foi marcado como RECEBIDO com a quantidade informada; cadastre uma nova entrada para o saldo se ele ainda vier.`:null,
    transito:nr.rows[0]})
})

// Converte um registro existente em transferência entre CDs, preservando
// NF, previsão, status e histórico. Só mexe em tipo, origem e data de saída.
app.patch('/api/transito/:id/movimentacao',async c=>{
  await initDb(c.env.DB)
  const id=Number(c.req.param('id'))
  if(isNaN(id)) return c.json({error:'ID inválido'},400)
  let b:any;try{b=await c.req.json()}catch{return c.json({error:'Invalid JSON'},400)}
  const ex=await c.env.DB.query('SELECT * FROM compras_em_transito WHERE id=? AND ativo=1',[id])
  if(!ex.rows.length) return c.json({error:'Registro não encontrado'},404)
  const cur=ex.rows[0] as any
  const tipo=b.tipo_movimentacao?String(b.tipo_movimentacao).toUpperCase():cur.tipo_movimentacao
  if(!TIPOS_MOVIMENTACAO.includes(tipo as any)) return c.json({error:'tipo_movimentacao inválido'},400)
  const cdOrigem=b.cd_origem!==undefined?(b.cd_origem?String(b.cd_origem).toUpperCase():null):cur.cd_origem
  if(tipo==='TRANSFERENCIA_CD'&&!cdOrigem) return c.json({error:'Transferência exige cd_origem'},400)
  if(tipo==='TRANSFERENCIA_CD'&&cdOrigem===cur.cd) return c.json({error:'Origem e destino iguais'},400)
  const dataSaida=b.data_saida!==undefined?(b.data_saida||null):cur.data_saida
  const apuracao=b.apuracao!==undefined?(b.apuracao||null):cur.apuracao
  await c.env.DB.exec(`UPDATE compras_em_transito SET tipo_movimentacao=?,cd_origem=?,data_saida=?,apuracao=?,updated_at=datetime('now') WHERE id=?`,
    [tipo,cdOrigem,dataSaida,apuracao,id])
  await c.env.DB.exec(`INSERT INTO transito_historico(transito_id,status_anterior,status_novo,autor,observacao) VALUES(?,?,?,?,?)`,
    [id,`tipo:${cur.tipo_movimentacao||'COMPRA_FORNECEDOR'}`,`tipo:${tipo}`,b.autor||null,
     b.observacao||`Conversão para ${tipo}${cdOrigem?` (origem ${cdOrigem})`:''}. NF, previsão e status preservados.`])
  const nr=await c.env.DB.query('SELECT * FROM compras_em_transito WHERE id=?',[id])
  return c.json({ok:true,action:'movimentacao_atualizada',
    data_saida_status:dataSaida?'INFORMADA':'DATA_SAIDA_PENDENTE',transito:nr.rows[0]})
})

app.get('/api/transito/:id/historico',async c=>{
  await initDb(c.env.DB)
  const id=Number(c.req.param('id'))
  const rows=(await c.env.DB.query('SELECT * FROM transito_historico WHERE transito_id=? ORDER BY id DESC',[id])).rows
  return c.json({transito_id:id,total:rows.length,historico:rows})
})

app.put('/api/transito/:id',async c=>{
  await initDb(c.env.DB)
  const id=Number(c.req.param('id'))
  if(isNaN(id)) return c.json({error:'ID inválido'},400)
  let b:any;try{b=await c.req.json()}catch{return c.json({error:'Invalid JSON'},400)}
  const ex=await c.env.DB.query('SELECT * FROM compras_em_transito WHERE id=? AND ativo=1',[id])
  if(!ex.rows.length) return c.json({error:'Registro não encontrado'},404)
  const cur=ex.rows[0] as any
  const val=(k:string)=>b[k]===undefined?cur[k]:b[k]
  const qtd=b.quantidade===undefined?Number(cur.quantidade):Number(b.quantidade)
  if(isNaN(qtd)||qtd<0) return c.json({error:'quantidade inválida'},400)
  await c.env.DB.exec(`UPDATE compras_em_transito SET cd=?,marca=?,pool=?,canal=?,insumo=?,quantidade=?,unidade=?,data_prevista=?,observacao=?,updated_at=datetime('now') WHERE id=?`,
    [val('cd'),val('marca'),val('pool'),val('canal'),val('insumo'),qtd,val('unidade'),val('data_prevista'),val('observacao'),id])
  const nr=await c.env.DB.query('SELECT * FROM compras_em_transito WHERE id=?',[id])
  return c.json({ok:true,action:'updated',transito:nr.rows[0]})
})

app.delete('/api/transito/:id',async c=>{
  await initDb(c.env.DB)
  const id=Number(c.req.param('id'))
  if(isNaN(id)) return c.json({error:'ID inválido'},400)
  await c.env.DB.exec("UPDATE compras_em_transito SET ativo=0,updated_at=datetime('now') WHERE id=?",[id])
  return c.json({ok:true,action:'deleted',id})
})

async function buildPlanejamentoCtx(db:DB){
  const P=await loadParams(db)
  const fRows=(await db.query('SELECT * FROM fatores_consumo',[])).rows as any[]
  const mRows=(await db.query('SELECT * FROM mix_caixas',[])).rows as any[]
  // Chave marca|cd|insumo. Linhas com status NAO_DEFINIDO / coef nulo são
  // carregadas mas marcadas — nunca substituídas por fator de outra marca.
  const fatores:Record<string,any>={}
  for(const f of fRows) fatores[`${f.marca}|${f.cd}|${f.insumo}`]={
    coef:f.coef_principal==null?null:Number(f.coef_principal),
    unidade:f.unidade_coef,
    lead_time_d:f.lead_time_d==null?null:Number(f.lead_time_d),
    status:f.status||'DEFINIDO',fonte:f.fonte,
  }
  const mix:Record<string,any>={}
  for(const m of mRows) mix[`${m.marca}|${m.cd}`]=m
  const cfg={
    // dias-base: o sistema já possui 'dias_mes'. Reutiliza em vez de duplicar.
    diasBase:resolveParam(P,['dias_base_mes','dias_mes'],30.4),
    fatorSeg:resolveParam(P,['fator_seguranca'],0.5),
    // alerta: mantido no banco, mas NÃO é mais gatilho de caixas/Fita.
    fatorAlerta:resolveParam(P,['fator_alerta','alerta_fator'],1.3),
    embPorPedido:resolveParam(P,['embalagens_por_pedido'],1),
    // Política de estoque-alvo: 2 meses de consumo projetado.
    metaMeses:resolveParam(P,['meta_reposicao'],2),
    // Mantido no banco por histórico/custo. NÃO usado no FillPack.
    fillpackKgBob:resolveParam(P,['fillpack_kg_por_bob'],0),
    leadTimesOficiais:{chave:'lead_time_por_insumo',valor:LEAD_TIMES,origem:'tabela oficial'},
  }
  return{P,fatores,mix,cfg}
}

// Premissas em uso — transparência/auditoria
app.get('/api/premissas',async c=>{
  await initDb(c.env.DB)
  const{cfg}=await buildPlanejamentoCtx(c.env.DB)
  const fRows=(await c.env.DB.query('SELECT * FROM fatores_consumo ORDER BY insumo,marca',[])).rows
  const mRows=(await c.env.DB.query('SELECT * FROM mix_caixas ORDER BY marca',[])).rows
  const divergencias:any[]=[]
  if(Math.abs(cfg.fatorAlerta.valor-1.3)>0.001) divergencias.push({
    parametro:cfg.fatorAlerta.chave,valor_no_hub:cfg.fatorAlerta.valor,
    valor_historico_anexo:1.3,severidade:'DECIDIDO',
    impacto:'Threshold mantido no banco por compatibilidade. NÃO é gatilho de compra de caixas nem de Fita Gomada (o gatilho é o consumo do lead time oficial de cada insumo).'
  })
  const semFator=Array.from(new Set(
    (fRows as any[]).filter((r:any)=>r.coef_principal==null||r.status==='NAO_DEFINIDO')
      .map((r:any)=>`${r.marca} (${r.cd}) - ${r.insumo}`)))
  return c.json({
    config:cfg,
    politica:{
      estoque_alvo:`${cfg.metaMeses.valor} meses de consumo mensal projetado`,
      gatilho_caixas:'consumo do lead time de cada tamanho (PP 12d · P 7d · M 7d · G 9d · GG 9d)',
      gatilho_fita:'consumo do lead time de 16 dias',
      gatilho_fillpack:'estoque <= estoque mínimo (lead time 7,5 d) — política preservada',
      fillpack_unidade:'bobina/pedido — sem conversão de kg',
      pools:POOLS.map(p=>({pool:p.chave,label:p.label,insumo:p.insumo,cd:p.cd,marcas:p.marcas})),
    },
    fatores_consumo:fRows,
    mix_caixas:mRows,
    marcas_sem_fator_fita_fillpack:semFator,
    parametros_nao_usados_nesta_etapa:[
      {chave:'fillpack_kg_por_bob',motivo:'Não usado: o coeficiente do FillPack já é bobina/pedido. Mantido para conversões de peso/custo.'},
      {chave:'fita_kg_por_bobina',motivo:'Não usado: o coeficiente já é bobina/pedido. Mantido para conversões de peso/custo.'},
      {chave:'alerta_fator',motivo:'Mantido para o alerta legado do snapshot. Não é gatilho de caixas nem de Fita.'},
    ],
    divergencias,
  })
})

// Simulação avulsa — permite auditar/regredir sem criar Forecast
app.get('/api/planejamento/simular',async c=>{
  await initDb(c.env.DB)
  const q=c.req.query()
  const marca=String(q.marca??'').trim()
  const canal=String(q.canal??'B2C').toUpperCase()
  const cd=String(q.cd??'ES')
  const pedidos=Number(q.pedidos)
  if(!marca||!pedidos||isNaN(pedidos)) return c.json({error:'Obrigatório: marca, pedidos. Opcionais: cd, canal'},400)
  const{fatores,mix,cfg,P}=await buildPlanejamentoCtx(c.env.DB)
  const est=await loadEstoqueAtual(c.env.DB)
  const r=planejarCombinacao(marca,cd,canal,pedidos,fatores,mix,P,cfg,est.map)
  return c.json({modo:'simulacao',marca,cd,canal,pedidos,config:cfg,...r})
})

// Planejamento completo a partir do Forecast vigente
app.get('/api/planejamento',async c=>{
  await initDb(c.env.DB)
  const q=c.req.query()
  const now=new Date()
  const fc=await poolsDoForecast(c.env.DB,q.ano?Number(q.ano):now.getFullYear(),q.mes?Number(q.mes):(now.getMonth()+1))
  let resultado=fc.combos
  if(q.marca) resultado=resultado.filter((r:any)=>r.marca===q.marca)
  if(q.canal) resultado=resultado.filter((r:any)=>String(r.canal).toUpperCase()===String(q.canal).toUpperCase())
  const cfg=fc.cfg
  // Pools sempre consolidados sobre TODAS as marcas do período: filtrar por
  // marca não pode reduzir o estoque físico compartilhado do pool.
  const pools=fc.pools
  return c.json({config:cfg,periodo_forecast:fc.periodo,fallback_periodo:fc.fallback_periodo,
    total_combinacoes:resultado.length,pools,planejamento:resultado})
})

// Aplica o estoque mínimo dinâmico na tabela estoque_minimo.
// Só escreve combos com Forecast e canal elegível (não B2B/Marketplace).
// Linhas sem forecast permanecem intactas (legado preservado).
// ── Estoque mínimo a partir do Forecast — fonte única (v72) ──────────────────
// Usada por: POST /api/planejamento/aplicar-estoque-minimo (grava),
// GET /api/planejamento/estoque-minimo-preview (não grava — dry-run para a
// aba Preview de Parâmetros) e POST /api/parametros (grava, ao salvar
// parâmetros). Mesma função, mesma fórmula, em todo lugar — sem cálculo
// paralelo. persistir=false roda a MESMA lógica sem INSERT algum.
async function calcularEstoqueMinimoForecast(db:DB,ano:number,mes:number,persistir:boolean){
  const forecasts=(await db.query('SELECT * FROM forecast_mensal WHERE ano=? AND mes=?',[ano,mes])).rows as any[]
  if(!forecasts.length) return{ok:false as const,error:`Nenhum forecast para ${mes}/${ano}`,itens:[],ignorados:[]}
  const mixCdRows=(await db.query('SELECT * FROM mix_cd',[])).rows as any[]
  const mixCd:Record<string,{cd:string;pct_cd:number}[]>={}
  for(const r of mixCdRows){if(!mixCd[r.marca])mixCd[r.marca]=[];mixCd[r.marca].push({cd:r.cd,pct_cd:Number(r.pct_cd)})}
  const{fatores,mix,cfg,P}=await buildPlanejamentoCtx(db)
  const est=await loadEstoqueAtual(db)
  const itens:any[]=[];const ignorados:any[]=[]
  for(const f of forecasts){
    // Marketplace: distribuicao SP/MG ainda nao definida. Nao aplicar o mix
    // B2C da marca (isso escreveria estoque_minimo em ES/RJ para demanda que
    // é de Marketplace). Sinalizar e pular, sem inventar nenhum split.
    if(String(f.canal).toUpperCase()==='MARKETPLACE'){
      ignorados.push({marca:f.marca,cd:null,canal:f.canal,motivo:'DISTRIBUICAO_CD_PENDENTE'});continue
    }
    const dist=mixCd[f.marca]||[{cd:'ES',pct_cd:1.0}]
    for(const d of dist){
      const forecast_cd=Math.round(Number(f.forecast_pedidos)*d.pct_cd)
      const r=planejarCombinacao(f.marca,d.cd,f.canal,forecast_cd,fatores,mix,P,cfg,est.map)
      if(r.bloqueio){ignorados.push({marca:f.marca,cd:d.cd,canal:f.canal,motivo:r.bloqueio.motivo});continue}
      for(const it of r.itens){
        if(it.status!=='OK'){ignorados.push({marca:f.marca,cd:d.cd,canal:f.canal,insumo:it.insumo,motivo:it.status});continue}
        if(persistir) await db.exec(
          'INSERT OR REPLACE INTO estoque_minimo(marca,cd,insumo,est_min,alerta_threshold,consumo_mensal,consumo_dia) VALUES(?,?,?,?,?,?,?)',
          [f.marca,d.cd,it.insumo,it.est_min_arred,it.alerta_arred,it.consumo_projetado_arred,it.consumo_dia])
        itens.push({marca:f.marca,cd:d.cd,insumo:it.insumo,lead_time:it.lead_time,
          est_min:it.est_min_arred,alerta:it.alerta_arred,
          consumo_mensal:it.consumo_projetado_arred,consumo_dia:it.consumo_dia})
      }
    }
  }
  return{ok:true as const,ano,mes,config:cfg,itens,ignorados}
}

app.post('/api/planejamento/aplicar-estoque-minimo',async c=>{
  await initDb(c.env.DB)
  let body:any={};try{body=await c.req.json()}catch{}
  const now=new Date()
  const ano=Number(body.ano??now.getFullYear());const mes=Number(body.mes??(now.getMonth()+1))
  const r=await calcularEstoqueMinimoForecast(c.env.DB,ano,mes,true)
  if(!r.ok) return c.json(r,400)
  return c.json({ok:true,ano,mes,config:r.config,aplicados_count:r.itens.length,aplicados:r.itens,ignorados:r.ignorados})
})

// Preview READ-ONLY: mesma conta de aplicar-estoque-minimo, sem gravar nada.
// Usada pela aba "📊 Preview — Estoque Mínimo Calculado" para mostrar o
// consumo_mensal/consumo_dia real (do Forecast vigente) antes de salvar.
app.get('/api/planejamento/estoque-minimo-preview',async c=>{
  await initDb(c.env.DB)
  const now=new Date()
  const ano=Number(c.req.query('ano')??now.getFullYear())
  const mes=Number(c.req.query('mes')??(now.getMonth()+1))
  const r=await calcularEstoqueMinimoForecast(c.env.DB,ano,mes,false)
  if(!r.ok) return c.json(r,400)
  return c.json({ok:true,ano,mes,itens:r.itens,ignorados:r.ignorados})
})

// ── Visão consolidada de Sugestão de Compra ───────────────────────────────────
// Uma linha por POOL FÍSICO (evita duplicidade por marca).
// Rastreabilidade do consumo por marca preservada em `detalhe_consumo`.
// ── Fonte única de consumo operacional: o Forecast vigente ────────────────────
// Forecast -> Mix CD -> Forecast por CD -> fator/mix -> consumo por marca
// -> consolidação por pool. Snapshot, Planejamento e Sugestão de Compra
// consomem esta MESMA função — não existe segunda implementação da fórmula.
// Período: ano/mês informados; se ausentes, o mês corrente (mesma regra já
// usada por /api/sugestao-compra).
async function poolsDoForecast(db:DB,ano?:number,mes?:number){
  const now=new Date()
  const anoAlvo=ano??now.getFullYear()
  const mesAlvo=mes??(now.getMonth()+1)
  let forecasts=(await db.query('SELECT * FROM forecast_mensal WHERE ano=? AND mes=?',[anoAlvo,mesAlvo])).rows as any[]
  // Sem Forecast no período não há como projetar consumo. Em vez de inventar
  // regra nova, usa o Forecast mais recente disponível e SINALIZA o fallback.
  let periodoUsado={ano:anoAlvo,mes:mesAlvo};let fallback=false
  if(!forecasts.length){
    const ult=(await db.query('SELECT ano,mes FROM forecast_mensal ORDER BY ano DESC,mes DESC LIMIT 1',[])).rows as any[]
    if(ult.length){
      periodoUsado={ano:Number(ult[0].ano),mes:Number(ult[0].mes)};fallback=true
      forecasts=(await db.query('SELECT * FROM forecast_mensal WHERE ano=? AND mes=?',[periodoUsado.ano,periodoUsado.mes])).rows as any[]
    }
  }
  const mixCdRows=(await db.query('SELECT * FROM mix_cd',[])).rows as any[]
  const mixCd:Record<string,{cd:string;pct_cd:number}[]>={}
  for(const r of mixCdRows){if(!mixCd[r.marca])mixCd[r.marca]=[];mixCd[r.marca].push({cd:r.cd,pct_cd:Number(r.pct_cd)})}
  const{fatores,mix,cfg,P}=await buildPlanejamentoCtx(db)
  const est=await loadEstoqueAtual(db)
  const transito=await loadTransito(db)
  const combos:any[]=[]
  for(const f of forecasts){
    // Marketplace: mesma guarda de /api/forecast/distribuido e de
    // aplicar-estoque-minimo — nao rotear via mix_cd da marca (premissa B2C).
    // Sem distribuicao SP/MG definida, nao ha pool nem compra calculavel.
    if(String(f.canal).toUpperCase()==='MARKETPLACE'){
      combos.push({ano:f.ano,mes:f.mes,marca:f.marca,cd:null,canal:f.canal,
        forecast_marca:Number(f.forecast_pedidos),pct_cd:null,pct_cd_formatado:null,forecast_cd:null,
        semana_estoque:null,
        bloqueio:{motivo:'DISTRIBUICAO_CD_PENDENTE',
          mensagem:'Marketplace opera em SP e MG, mas a distribuição percentual entre os dois CDs ainda não foi definida. Nenhuma unidade de compra foi gerada a partir deste forecast.'},
        itens:[]})
      continue
    }
    const dist=mixCd[f.marca]||[{cd:'ES',pct_cd:1.0}]
    for(const d of dist){
      const forecast_cd=Math.round(Number(f.forecast_pedidos)*d.pct_cd)
      const r=planejarCombinacao(f.marca,d.cd,f.canal,forecast_cd,fatores,mix,P,cfg,est.map)
      combos.push({ano:f.ano,mes:f.mes,marca:f.marca,cd:d.cd,canal:f.canal,
        forecast_marca:Number(f.forecast_pedidos),pct_cd:d.pct_cd,
        pct_cd_formatado:`${Math.round(d.pct_cd*100)}%`,forecast_cd,
        semana_estoque:est.semanas[`${f.marca}|${d.cd}`]??null,
        bloqueio:r.bloqueio,itens:r.itens})
    }
  }
  const pools=consolidarPools(combos,est.map,cfg,P,transito,est.datas,est.timestamps)
  return{pools,combos,cfg,P,est,transito,periodo:periodoUsado,
    periodo_solicitado:{ano:anoAlvo,mes:mesAlvo},fallback_periodo:fallback,
    sem_forecast:!forecasts.length}
}

// ── Precificação da Sugestão de Compra ───────────────────────────────────────
// Fornecedor: o já marcado como tipo='PRINCIPAL' na tabela fornecedores.
// A tabela é global por insumo (não há granularidade por CD) — a regra
// existente é respeitada como está, sem inventar nova granularidade.
// A multiplicação só ocorre quando a unidade do preço é a MESMA da quantidade
// planejada. Nenhuma conversão implícita (kg<->bobina) é feita.
// FillPack: o principal tem valor_bobina preenchido => preço em R$/bobina.
function precificar(insumo:string,unidadeQtd:string,quantidade:number|null,principal:any,P:Params={}){
  if(!principal) return{fornecedor_principal:'NÃO DEFINIDO',preco_unitario:null,
    preco_unidade:null,custo_total:null,preco_status:'SEM_FORNECEDOR',
    preco_observacao:`Nenhum fornecedor marcado como PRINCIPAL para ${insumo}.`,
    preco_cadastrado:null,preco_cadastrado_unidade:null,fator_conversao:null}
  // Preço por bobina tem precedência quando cadastrado (caso do FillPack:
  // valor_bobina preenchido => o preço JÁ é R$/bobina, sem conversão).
  const temBobina=principal.valor_bobina!=null&&Number(principal.valor_bobina)>0
  const precoCad=temBobina?Number(principal.valor_bobina):Number(principal.valor_un)
  const unidadeCad=temBobina?'BOBINA':String(principal.unidade||'').toUpperCase()
  const unQtd=String(unidadeQtd).toUpperCase()
  const base={fornecedor_principal:principal.nome,
    preco_cadastrado:precoCad,preco_cadastrado_unidade:unidadeCad,
    fator_conversao:null as number|null,
    preco_unitario:null as number|null,preco_unidade:unidadeCad,
    custo_total:null as number|null,
    preco_status:'OK',preco_observacao:null as string|null}
  if(!precoCad||!isFinite(precoCad)) return{...base,
    preco_status:'SEM_PRECO',preco_observacao:`Fornecedor principal sem preço válido para ${insumo}.`}

  let preco=precoCad, fator:number|null=null, obs:string|null=null
  if(unidadeCad!==unQtd){
    // Conversão explícita, apenas com fator confirmado e parametrizado no Hub.
    // Fita Gomada: preço em R$/kg e compra em bobinas -> fita_kg_por_bobina
    // (1,37 kg/bobina, confirmado com a Cyklop; vale também para a RITUÁRIA).
    const kgBob=Number(P['fita_kg_por_bobina'])
    if(insumo==='Fita Gomada'&&unidadeCad==='KG'&&unQtd==='BOBINA'&&kgBob>0){
      fator=kgBob
      preco=Math.round(precoCad*kgBob*100)/100
      obs=`Preço cadastrado em R$/kg. Convertido com fita_kg_por_bobina = ${kgBob} kg/bobina: ${precoCad} × ${kgBob} = ${preco} por bobina.`
    }else{
      return{...base,preco_unitario:precoCad,preco_status:'UNIDADE_INCOMPATIVEL',
        preco_observacao:`Preço cadastrado em ${unidadeCad} e quantidade planejada em ${unQtd}. Nenhuma conversão foi aplicada — não há fator de conversão confirmado para este insumo.`}
    }
  }
  const q=quantidade??0
  return{...base,fator_conversao:fator,preco_unitario:preco,preco_unidade:unQtd,
    custo_total:Math.round(q*preco*100)/100,
    preco_status:fator?'OK_CONVERTIDO':'OK',preco_observacao:obs}
}

// ── Camada fiscal: resolução de entidade de faturamento ──────────────────────
// Roda DEPOIS da necessidade calculada. Não toca em Forecast, mix, fatores,
// consumo, estoque mínimo, cobertura nem na matemática da compra.
// Prioridade: regra marca+CD vence regra só de marca. Empate ou ausência de
// regra NÃO é resolvido por heurística — devolve pendência explícita.
async function carregarEntidades(db:DB){
  return (await db.query('SELECT * FROM entidades_faturamento WHERE ativo=1',[])).rows as any[]
}

async function carregarRegrasFaturamento(db:DB){
  const rows=(await db.query(`SELECT r.*, e.codigo AS ent_codigo, e.razao_social, e.cnpj,
      e.cnpj_informado, e.cnpj_status
    FROM regras_faturamento r
    JOIN entidades_faturamento e ON e.id=r.entidade_faturamento_id
    WHERE r.ativo=1 AND e.ativo=1
    ORDER BY r.prioridade DESC, r.id`,[])).rows as any[]
  return rows
}

function resolverFaturamento(regras:any[],marca:string,cd:string,entidades:any[]=[],hoje=new Date().toISOString().slice(0,10)){
  const vigente=(r:any)=>(!r.vigencia_inicio||r.vigencia_inicio<=hoje)&&(!r.vigencia_fim||r.vigencia_fim>=hoje)
  const cand=regras.filter(r=>r.marca_cod===marca&&vigente(r)&&(r.cd_cod==null||r.cd_cod===cd))
  if(!cand.length) return{entidade:null,cnpj:null,cnpj_status:null,
    status:'REGRA_FATURAMENTO_PENDENTE',
    motivo:`Nenhuma regra de faturamento ativa para ${marca}${cd?` / ${cd}`:''}. Nenhuma entidade foi atribuída por inferência.`}
  const maxPri=Math.max(...cand.map(r=>Number(r.prioridade)))
  const topo=cand.filter(r=>Number(r.prioridade)===maxPri)
  // Empate na mesma prioridade com entidades diferentes: ambiguidade real.
  const distintas=[...new Set(topo.map(r=>r.ent_codigo))]
  if(distintas.length>1) return{entidade:null,cnpj:null,cnpj_status:null,
    status:'REGRA_FATURAMENTO_PENDENTE',
    motivo:`Regras conflitantes de mesma prioridade para ${marca}/${cd}: ${distintas.join(' e ')}. Decisão fiscal não pode ser inferida.`}
  const r=topo[0]
  // Regra genérica de marca (sem CD) apontando para entidade de OUTRO CD,
  // havendo entidade do mesmo grupo para o CD da linha: a decisão fiscal é
  // ambígua e NÃO foi fornecida. Não escolher por conta própria (item 4).
  if(r.cd_cod==null&&cd){
    const m=String(r.ent_codigo).match(/^(.*)_([A-Z]{2})$/)
    if(m&&m[2]!==cd){
      const alt=entidades.find(e=>e.codigo===`${m[1]}_${cd}`)
      if(alt) return{entidade:null,cnpj:null,cnpj_status:null,
        status:'REGRA_FATURAMENTO_PENDENTE',
        motivo:`Necessidade de ${marca} no CD ${cd}. A regra vigente é genérica de marca e aponta para ${r.ent_codigo}, mas existe ${alt.codigo} para este CD. Não há regra explícita para decidir entre as duas — cadastre uma regra ${marca}+${cd} em regras_faturamento.`,
        candidatas:[r.ent_codigo,alt.codigo]}
    }
  }
  return{entidade_codigo:r.ent_codigo,entidade:r.razao_social,
    cnpj:r.cnpj,cnpj_informado:r.cnpj_informado,cnpj_status:r.cnpj_status,
    regra_id:r.id,regra_escopo:r.cd_cod?`${r.marca_cod}+${r.cd_cod}`:r.marca_cod,
    prioridade:Number(r.prioridade),
    status:r.cnpj_status==='VALIDADO'?'OK':'CNPJ_PENDENTE_VALIDACAO'}
}

// ── Cadastro fiscal (leitura) ────────────────────────────────────────────────
app.get('/api/faturamento/entidades',async c=>{
  await initDb(c.env.DB)
  const rows=(await c.env.DB.query('SELECT * FROM entidades_faturamento ORDER BY codigo',[])).rows as any[]
  return c.json(rows.map(e=>({...e,validacao:validarCNPJ(e.cnpj_informado)})))
})

app.get('/api/faturamento/regras',async c=>{
  await initDb(c.env.DB)
  const regras=await carregarRegrasFaturamento(c.env.DB)
  return c.json({
    prioridade:'Regra marca+CD (100) prevalece sobre regra de marca (50). Empate com entidades distintas gera REGRA_FATURAMENTO_PENDENTE.',
    total:regras.length,
    regras:regras.map(r=>({id:r.id,marca_cod:r.marca_cod,cd_cod:r.cd_cod,
      entidade:r.razao_social,entidade_codigo:r.ent_codigo,cnpj:r.cnpj,
      cnpj_status:r.cnpj_status,prioridade:r.prioridade,
      vigencia_inicio:r.vigencia_inicio,vigencia_fim:r.vigencia_fim,observacao:r.observacao})),
  })
})

// Simulador de resolução — auditoria da regra sem gerar pedido
app.get('/api/faturamento/resolver',async c=>{
  await initDb(c.env.DB)
  const q=c.req.query()
  if(!q.marca) return c.json({error:'Informe marca (e opcionalmente cd)'},400)
  const regras=await carregarRegrasFaturamento(c.env.DB)
  const ents=await carregarEntidades(c.env.DB)
  return c.json({marca:q.marca,cd:q.cd??null,...resolverFaturamento(regras,String(q.marca),String(q.cd??''),ents)})
})

// Atualiza a entidade de faturamento (CNPJ) de uma regra existente —
// redireciona marca(+CD) para outra entidade já cadastrada. Não cria nem
// apaga regra, não mexe em marca_cod/cd_cod/UNIQUE — só a entidade,
// prioridade e observação. Mudança AQUI é permanente e afeta todo cálculo
// de faturamento futuro (não é um ajuste pontual de planilha).
app.patch('/api/faturamento/regras/:id',async c=>{
  await initDb(c.env.DB)
  const id=Number(c.req.param('id'))
  if(isNaN(id)) return c.json({error:'ID inválido'},400)
  let b:any;try{b=await c.req.json()}catch{return c.json({error:'Invalid JSON'},400)}
  const ex=await c.env.DB.query('SELECT * FROM regras_faturamento WHERE id=?',[id])
  if(!ex.rows.length) return c.json({error:'Regra não encontrada'},404)
  const cur=ex.rows[0] as any
  let entidadeId=cur.entidade_faturamento_id
  if(b.entidade_codigo!==undefined){
    const ent=await c.env.DB.query('SELECT id FROM entidades_faturamento WHERE codigo=?',[String(b.entidade_codigo).toUpperCase()])
    if(!ent.rows.length) return c.json({error:`Entidade de faturamento inexistente: ${b.entidade_codigo}`},404)
    entidadeId=Number((ent.rows[0] as any).id)
  }
  const prioridade=b.prioridade!=null?Number(b.prioridade):cur.prioridade
  const observacao=b.observacao!==undefined?b.observacao:cur.observacao
  await c.env.DB.exec(`UPDATE regras_faturamento SET entidade_faturamento_id=?,prioridade=?,observacao=?,updated_at=datetime('now') WHERE id=?`,
    [entidadeId,prioridade,observacao,id])
  const nr=await c.env.DB.query(`SELECT r.*,e.codigo as ent_codigo,e.razao_social,e.cnpj FROM regras_faturamento r
    JOIN entidades_faturamento e ON e.id=r.entidade_faturamento_id WHERE r.id=?`,[id])
  return c.json({ok:true,action:'regra_atualizada',regra_anterior:cur,regra_nova:nr.rows[0]})
})

// ── Visão analítica (Marca+CD+Canal+Insumo) e visão de pedido/faturamento ────
// A necessidade nasce por POOL FÍSICO. A quantidade de cada marca vem da sua
// participação real no consumo projetado do pool (detalhe_consumo) — a mesma
// base usada pelo motor, sem recálculo paralelo.
// A consolidação fiscal só ocorre quando coincidem entidade + CNPJ +
// fornecedor + insumo + unidade. ES e RJ nunca se somam: CNPJs distintos.
// Alocação da necessidade do pool entre as marcas — MÉTODO DO MAIOR RESTO.
// A participação vem do consumo projetado; o fechamento inteiro preserva
// exatamente o total físico do pool. Nenhuma unidade é criada ou perdida.
// Determinístico: desempate por maior consumo e, se ainda empatar, por marca.
function alocarMaiorResto(total:number|null,partes:{marca:string;consumo:number}[]){
  const out:Record<string,number>={}
  for(const p of partes) out[p.marca]=0
  if(total==null||total<=0||!partes.length) return out
  const somaConsumo=partes.reduce((s,p)=>s+p.consumo,0)
  if(somaConsumo<=0) return out
  const brutos=partes.map(p=>{
    const bruto=total*(p.consumo/somaConsumo)
    const piso=Math.floor(bruto)
    return{marca:p.marca,consumo:p.consumo,piso,resto:bruto-piso}
  })
  let restantes=Math.round(total)-brutos.reduce((s,b)=>s+b.piso,0)
  brutos.sort((a,b)=>(b.resto-a.resto)||(b.consumo-a.consumo)||a.marca.localeCompare(b.marca))
  for(let i=0;i<brutos.length&&restantes>0;i++,restantes--) brutos[i].piso++
  for(const b of brutos) out[b.marca]=b.piso
  return out
}

async function visoesFiscais(db:DB,linhas:any[]){
  const regras=await carregarRegrasFaturamento(db)
  const entidades=await carregarEntidades(db)
  const analitico:any[]=[]
  for(const l of linhas){
    const c1=l.cenario_meta_global||{},c2=l.cenario_meta_insumo||{}
    const podePreco=l.preco_unitario!=null&&(l.preco_status==='OK'||l.preco_status==='OK_CONVERTIDO')
    const partes=(l.detalhe_consumo||[]).map((d:any)=>({marca:d.marca,consumo:Number(d.consumo_projetado)||0}))
    // Cada cenário é alocado de forma independente — a proporção arredondada
    // de um cenário nunca é reaproveitada no outro.
    const aVig=alocarMaiorResto(l.compra_sugerida,partes)
    const a1=alocarMaiorResto(c1.compra_sugerida,partes)
    const a2=alocarMaiorResto(c2.compra_sugerida,partes)
    const total=Number(l.consumo_mensal)||0
    for(const d of (l.detalhe_consumo||[])){
      const pct=total>0?d.consumo_projetado/total:0
      const qtd=l.compra_sugerida!=null?aVig[d.marca]:null
      const q1=c1.compra_sugerida!=null?a1[d.marca]:null
      const q2=c2.compra_sugerida!=null?a2[d.marca]:null
      const val=(q:number|null)=>(q!=null&&podePreco)?Math.round(q*l.preco_unitario*100)/100:null
      const fat=resolverFaturamento(regras,d.marca,l.cd,entidades)
      analitico.push({
        marca:d.marca,cd:l.cd,canal:l.canal,insumo:l.insumo,unidade:l.unidade,
        pool:l.pool,pool_label:l.label,
        consumo_projetado:d.consumo_projetado,participacao_pool:Math.round(pct*1000000)/1000000,
        metodo_alocacao:'RATEIO_POR_CONSUMO_DO_POOL_MAIOR_RESTO',
        identidade:IDENTIDADE_AGREGADA[d.marca]??null,
        quantidade_sugerida:qtd,
        quantidade_cenario1:q1,quantidade_cenario2:q2,
        meta_cenario1:c1.meta_meses??null,meta_cenario2:c2.meta_meses??null,
        estoque_atual:l.estoque_atual,estoque_transito:l.estoque_transito,
        data_snapshot:l.data_snapshot,estoque_estimado_hoje:l.estoque_estimado_hoje,
        cobertura_estimada_hoje:l.cobertura_estimada_hoje,
        transito_vencido:l.transito_vencido,prioridade:l.prioridade,
        gap_para_meta:l.gap_para_meta,
        estoque_minimo:l.estoque_minimo,estoque_alvo:l.estoque_alvo,
        cobertura_dias:l.cobertura_dias,
        confiabilidade_posicao:l.confiabilidade_posicao,frescor_snapshot:l.frescor_snapshot,
        estimativa_material:l.estimativa_material,revisao_recomendada:l.revisao_recomendada,
        fornecedor_principal:l.fornecedor_principal,preco_unitario:l.preco_unitario,
        valor_total:val(qtd),valor_cenario1:val(q1),valor_cenario2:val(q2),
        entidade_faturamento:fat.entidade??null,entidade_codigo:fat.entidade_codigo??null,
        cnpj_faturamento:fat.cnpj??null,cnpj_status:fat.cnpj_status??null,
        regra_escopo:fat.regra_escopo??null,faturamento_status:fat.status,
        faturamento_motivo:fat.motivo??null,
      })
    }
  }
  // Consolidação: mesma entidade + CNPJ + CD + fornecedor + insumo + unidade.
  // O CD entra na chave — ES e RJ jamais se somam, por terem CNPJs distintos.
  const mapa:Record<string,any>={}
  const pendentes:any[]=[]
  for(const a of analitico){
    if(a.faturamento_status==='REGRA_FATURAMENTO_PENDENTE'){pendentes.push(a);continue}
    const k=[a.entidade_codigo,a.cnpj_faturamento,a.cd,a.fornecedor_principal??'SEM_FORNECEDOR',a.insumo,a.unidade].join('|')
    const g=mapa[k]||(mapa[k]={
      entidade_faturamento:a.entidade_faturamento,entidade_codigo:a.entidade_codigo,
      cnpj_faturamento:a.cnpj_faturamento,cnpj_status:a.cnpj_status,cd:a.cd,cds:[a.cd],
      fornecedor:a.fornecedor_principal,insumo:a.insumo,unidade:a.unidade,
      preco_unitario:a.preco_unitario,
      quantidade_total:0,valor_total:0,
      quantidade_cenario1:0,valor_cenario1:0,
      quantidade_cenario2:0,valor_cenario2:0,
      composicao:[] as any[],composicao_cenario1:[] as any[],composicao_cenario2:[] as any[]})
    g.quantidade_total+=a.quantidade_sugerida||0
    g.valor_total=Math.round((g.valor_total+(a.valor_total||0))*100)/100
    g.quantidade_cenario1+=a.quantidade_cenario1||0
    g.valor_cenario1=Math.round((g.valor_cenario1+(a.valor_cenario1||0))*100)/100
    g.quantidade_cenario2+=a.quantidade_cenario2||0
    g.valor_cenario2=Math.round((g.valor_cenario2+(a.valor_cenario2||0))*100)/100
    g.composicao.push({marca:a.marca,cd:a.cd,canal:a.canal,quantidade:a.quantidade_sugerida,valor:a.valor_total})
    if(a.quantidade_cenario1) g.composicao_cenario1.push({marca:a.marca,cd:a.cd,quantidade:a.quantidade_cenario1})
    if(a.quantidade_cenario2) g.composicao_cenario2.push({marca:a.marca,cd:a.cd,quantidade:a.quantidade_cenario2})
  }
  const pedido=Object.values(mapa).filter((g:any)=>g.quantidade_cenario1>0||g.quantidade_cenario2>0||g.quantidade_total>0)

  // Reconciliação exata. Com maior resto, Σ marcas = total do pool sempre.
  const soma=(arr:any[],k:string)=>Math.round(arr.reduce((s2,x)=>s2+(x[k]||0),0)*100)/100
  const totalMotor=(k:string)=>Math.round(linhas.reduce((s2,l)=>s2+
    ((k==='vigente'?l.compra_sugerida
     :k==='c1'?(l.cenario_meta_global||{}).compra_sugerida
     :(l.cenario_meta_insumo||{}).compra_sugerida)||0),0))
  const recon=(k:string,kDet:string,kFat:string)=>{
    const motor=totalMotor(k)
    const det=soma(analitico,kDet)
    const fat=soma(pedido,kFat)
    const pend=soma(pendentes,kDet)
    return{motor,detalhado:det,faturamento:fat,pendencias:pend,
      faturamento_mais_pendencias:Math.round((fat+pend)*100)/100,
      diferenca:Math.round((fat+pend-motor)*100)/100,
      diferenca_detalhado:Math.round((det-motor)*100)/100,
      confere:(fat+pend)===motor&&det===motor}
  }

  // Auditoria por pool: Σ marcas tem de bater com a necessidade do pool.
  const auditoriaPools:any[]=[]
  for(const l of linhas){
    const marcas=analitico.filter(a=>a.pool===l.pool)
    for(const[cen,orig,campo] of [
      ['VIGENTE',l.compra_sugerida,'quantidade_sugerida'],
      ['CENARIO_1',(l.cenario_meta_global||{}).compra_sugerida,'quantidade_cenario1'],
      ['CENARIO_2',(l.cenario_meta_insumo||{}).compra_sugerida,'quantidade_cenario2'],
    ] as any[]){
      if(!orig) continue
      const somaMarcas=marcas.reduce((s2,a)=>s2+(a[campo]||0),0)
      const ents=[...new Set(marcas.filter(a=>a[campo]).map(a=>a.entidade_codigo??'PENDENTE'))]
      const faturado=pedido.filter((g:any)=>g.cd===l.cd&&g.insumo===l.insumo)
        .reduce((s2:number,g:any)=>s2+(g[campo==='quantidade_sugerida'?'quantidade_total':campo]||0),0)
      const pend=pendentes.filter(a=>a.pool===l.pool).reduce((s2,a)=>s2+(a[campo]||0),0)
      auditoriaPools.push({cenario:cen,cd:l.cd,insumo:l.insumo,pool:l.pool,
        quantidade_original:orig,soma_marcas:somaMarcas,diferenca:somaMarcas-orig,
        entidades:ents,soma_faturada:faturado+pend,diferenca_final:(faturado+pend)-orig})
    }
  }

  // Trava de exportação: composição tem de somar exatamente a quantidade.
  const violacoes:any[]=[]
  for(const g of pedido as any[]){
    const chk=(qk:string,ck:string,rot:string)=>{
      const sc=(g[ck]||[]).reduce((s2:number,c:any)=>s2+(c.quantidade||0),0)
      if(sc!==g[qk]) violacoes.push({entidade:g.entidade_faturamento,cd:g.cd,insumo:g.insumo,
        cenario:rot,quantidade:g[qk],soma_composicao:sc,diferenca:sc-g[qk]})
    }
    chk('quantidade_cenario1','composicao_cenario1','CENARIO_1')
    chk('quantidade_cenario2','composicao_cenario2','CENARIO_2')
  }

  return{
    faturamento:{
      regra:'necessidade calculada -> classificação fiscal -> exportação. A camada fiscal não altera nenhuma quantidade.',
      consolidacao:'permitida apenas com mesma entidade + CNPJ + CD + fornecedor + insumo + unidade',
      metodo_alocacao:'RATEIO_POR_CONSUMO_DO_POOL — participação da marca no consumo projetado do pool',
      analitico_linhas:analitico.length,
      pedido_linhas:pedido.length,
      pendencias:pendentes.map(p=>({marca:p.marca,cd:p.cd,insumo:p.insumo,
        quantidade:p.quantidade_sugerida,quantidade_cenario1:p.quantidade_cenario1,
        quantidade_cenario2:p.quantidade_cenario2,motivo:p.faturamento_motivo})),
      quantidade_pendente:pendentes.reduce((s2,p)=>s2+(p.quantidade_sugerida||0),0),
      reconciliacao:{
        vigente:recon('vigente','quantidade_sugerida','quantidade_total'),
        cenario1:recon('c1','quantidade_cenario1','quantidade_cenario1'),
        cenario2:recon('c2','quantidade_cenario2','quantidade_cenario2'),
        nota:'Maior resto: Σ alocação por marca = necessidade do pool, sem exceção. diferenca = 0 é obrigatório.',
      },
      auditoria_pools:auditoriaPools,
      pools_com_diferenca:auditoriaPools.filter(p=>p.diferenca!==0||p.diferenca_final!==0).length,
      composicao_violacoes:violacoes,
      exportacao_liberada:violacoes.length===0
        &&auditoriaPools.every(p=>p.diferenca===0&&p.diferenca_final===0),
    },
    analitico,
    pedido_faturamento:pedido,
  }
}

app.get('/api/sugestao-compra',async c=>{
  await initDb(c.env.DB)
  const q=c.req.query()
  const now=new Date()
  const ano=Number(q.ano??now.getFullYear());const mes=Number(q.mes??(now.getMonth()+1))
  const fc=await poolsDoForecast(c.env.DB,ano,mes)
  const pools=fc.pools;const cfg=fc.cfg
  // Fornecedor PRINCIPAL por insumo — mesma estrutura/critério da aba Fornecedores.
  const fornRows=(await c.env.DB.query("SELECT * FROM fornecedores WHERE tipo='PRINCIPAL' ORDER BY id",[])).rows as any[]
  const principalPorInsumo:Record<string,any>={}
  for(const f of fornRows) if(!principalPorInsumo[f.insumo]) principalPorInsumo[f.insumo]=f
  const P=fc.P
  // Cenário A = meta global (meta_reposicao, hoje 2 meses) — o vigente.
  // Cenário B = meta por insumo (meta_<insumo>), sem alterar o A.
  const metaGlobal=cfg.metaMeses.valor
  const metaDe=(insumo:string)=>{
    const v=P[`meta_${insumo}`]
    return(v!=null&&isFinite(v))?{meses:v,origem:`meta_${insumo}`}:{meses:metaGlobal,origem:'meta_reposicao'}
  }
  // Recalcula alvo/necessidade/compra/custo para uma meta arbitrária.
  // Mesma fórmula do cenário vigente — só o número de meses muda.
  const cenario=(p:any,meses:number,preco:number|null,status:string)=>{
    const alvo=Math.round(p.consumo_mensal*meses)
    // Mesma base oficial da compra vigente. As METAS de C1/C2 nao mudam.
    const est=p.estoque_base_compra??p.estoque_atual
    if(est==null) return{meta_meses:meses,estoque_alvo:alvo,estoque_projetado:null,compra_sugerida:null,custo_total:null}
    const proj=Math.max(0,alvo-est)
    const compra=Math.max(0,proj-(p.estoque_transito||0))
    const podePrecificar=preco!=null&&(status==='OK'||status==='OK_CONVERTIDO')
    return{meta_meses:meses,estoque_alvo:alvo,estoque_projetado:proj,compra_sugerida:compra,
      custo_total:podePrecificar?Math.round(compra*preco*100)/100:null}
  }
  // Contrato EXPLÍCITO. Não usar spread: o objeto do pool carrega estruturas
  // internas (detalhe_estimativa, eventos_projecao, timeline_transito,
  // fallback_periodo, regra_status) que não precisam ir ao frontend.
  // A lista anterior era explícita mas ficou desatualizada — qualquer métrica
  // nova era descartada em silêncio. Ao acrescentar campos ao pool, incluir
  // aqui também.
  const linhas=pools.map(p=>({
    pool:p.pool,label:p.label,marcas:p.marcas,cd:p.cd,canal:'B2C',insumo:p.insumo,unidade:p.unidade,
    consumo_mensal:p.consumo_mensal,consumo_dia:p.consumo_dia,
    // Posições de estoque, com nomes inequívocos
    estoque_atual:p.estoque_atual,estoque_snapshot:p.estoque_snapshot,
    data_snapshot:p.data_snapshot,dias_desde_snapshot:p.dias_desde_snapshot,
    estoque_estimado_hoje:p.estoque_estimado_hoje,
    cobertura_estimada_hoje:p.cobertura_estimada_hoje,
    cobertura_dias:p.cobertura_dias,
    recebido_apos_snapshot:p.recebido_apos_snapshot,
    saidas_apos_snapshot:p.saidas_apos_snapshot,saidas_sem_data:p.saidas_sem_data,
    detalhe_saidas:p.detalhe_saidas,
    // Risco
    lead_time:p.lead_time,limite_alerta_dias:p.limite_alerta_dias,
    consumo_lead_time:p.consumo_lead_time,estoque_minimo:p.estoque_minimo,
    margem_lt:p.margem_lt,prioridade:p.prioridade,status:p.status,
    // QUANDO comprar (não confundir com prioridade, que é o que RECEBER antes)
    data_limite_pedido:p.data_limite_pedido,dias_ate_limite_pedido:p.dias_ate_limite_pedido,
    status_pedido:p.status_pedido,dias_atraso_pedido:p.dias_atraso_pedido,
    motivo_pedido:p.motivo_pedido,lead_time_dias_corridos:p.lead_time_dias_corridos,
    projecao_confiavel:p.projecao_confiavel,alerta_projecao:p.alerta_projecao,
    base_status:p.base_status,base_proximo_pedido:p.base_proximo_pedido,
    saidas_futuras:p.saidas_futuras,
    // Entradas e projeção
    estoque_transito:p.estoque_transito,
    estoque_transito_vencido:p.transito_vencido,
    transito_confiavel:p.transito_confiavel,
    recebidos_total:(p.recebidos||[]).reduce((s2:number,r:any)=>s2+(Number(r.quantidade_recebida)||0),0),
    data_prevista:p.data_prevista,
    estoque_projetado_futuro:p.estoque_projetado_futuro,
    data_projecao:p.data_projecao,data_ruptura_projetada:p.data_ruptura_projetada,
    estoque_pos_chegada:p.estoque_pos_chegada,cobertura_pos_chegada:p.cobertura_pos_chegada,
    ruptura_antes_da_chegada:p.ruptura_antes_da_chegada,
    // Meta e compra — base inalterada (ver base_calculo_compra)
    meta_meses:p.meta_meses,estoque_alvo:p.estoque_alvo,
    gap_para_meta:p.gap_para_meta,estoque_projetado:p.estoque_projetado,
    compra_sugerida:p.compra_sugerida,
    // Auditabilidade da decisao de compra
    estoque_base_compra:p.estoque_base_compra,base_calculo_compra:p.base_calculo_compra,
    transito_confiavel_aplicavel:p.transito_confiavel,
    gap_para_meta_snapshot:p.gap_para_meta_snapshot,
    compra_sugerida_snapshot:p.compra_sugerida_snapshot,
    regra_compra:p.regra_compra,base_compra_sugerida:p.base_compra_sugerida,
    // Camada de confiabilidade (v67) — informativa, nao influencia compra/preco/custo
    consumo_estimado_desde_snapshot:p.consumo_estimado_desde_snapshot,
    pct_consumo_estimado_sobre_snapshot:p.pct_consumo_estimado_sobre_snapshot,
    estimativa_material:p.estimativa_material,origem_variacao:p.origem_variacao,
    frescor_snapshot:p.frescor_snapshot,confiabilidade_posicao:p.confiabilidade_posicao,
    revisao_recomendada:p.revisao_recomendada,
    ...precificar(p.insumo,p.unidade,p.compra_sugerida,principalPorInsumo[p.insumo],fc.P),
    detalhe_consumo:p.detalhe_consumo,detalhe_transito:p.detalhe_transito,
  })).map(l=>{
    const pool=pools.find(x=>x.pool===l.pool)
    const m=metaDe(l.insumo)
    return{...l,
      cenario_meta_global:cenario(pool,metaGlobal,l.preco_unitario,l.preco_status),
      cenario_meta_insumo:{...cenario(pool,m.meses,l.preco_unitario,l.preco_status),origem_meta:m.origem},
    }
  })
  // Custo do período: soma dos custos por linha (uma linha por pool físico).
  const comCusto=linhas.filter(l=>l.custo_total!=null)
  const semPreco=linhas.filter(l=>l.custo_total==null&&(l.compra_sugerida??0)>0)
  const custo_total=Math.round(comCusto.reduce((s,l)=>s+(l.custo_total||0),0)*100)/100
  const somaCen=(k:'cenario_meta_global'|'cenario_meta_insumo')=>{
    const com=linhas.filter(l=>l[k].custo_total!=null)
    const sem=linhas.filter(l=>l[k].custo_total==null&&(l[k].compra_sugerida??0)>0)
    return{custo_total:Math.round(com.reduce((s,l)=>s+(l[k].custo_total||0),0)*100)/100,
      itens_com_compra:linhas.filter(l=>(l[k].compra_sugerida??0)>0).length,
      itens_sem_preco:sem.length,completo:sem.length===0}
  }
  return c.json({
    ano,mes,periodo_forecast:fc.periodo,fallback_periodo:fc.fallback_periodo,
    config:cfg,
    regra:{
      consumo:'Forecast vigente x Mix CD x fator/mix, consolidado por pool (fonte única)',
      consumo_dia:'consumo mensal projetado do pool / 30,4',
      estoque_minimo:'consumo_dia x lead time x (1 + fator de segurança)',
      base_calculo_compra:'ESTOQUE_OPERACIONAL_HOJE. A compra sugerida usa a posição operacional (snapshot + recebimentos confirmados posteriores − consumo posterior − saídas posteriores), a mesma base do Status e da Cobertura. Base antiga preservada em compra_sugerida_snapshot para auditoria.',
      estoque_alvo:'consumo mensal projetado x 2',
      estoque_projetado:'MAX(0, alvo - estoque atual)',
      compra_sugerida:'MAX(0, estoque projetado - em trânsito)',
      status:'simula as entradas em trânsito em ordem cronológica; CRÍTICO se houver ruptura antes de alguma chegada ou se o estoque projetado <= consumo do lead time; ALERTA se cobrir o lead time mas ficar abaixo do estoque mínimo; OK a partir do estoque mínimo',
      transito:'entra no Status pela linha do tempo das chegadas e é abatido da Sugestão de Compra; não é somado ao estoque físico atual',
    },
    custo:{
      custo_total_conhecido:custo_total,
      itens_sem_preco:semPreco.length,
      itens_sem_preco_detalhe:semPreco.map(l=>({pool:l.pool,label:l.label,insumo:l.insumo,
        quantidade:l.compra_sugerida,unidade:l.unidade,motivo:l.preco_status,
        observacao:l.preco_observacao})),
      completo:semPreco.length===0,
      regra:'custo por linha = sugestão de compra x preço do fornecedor PRINCIPAL, na mesma unidade; uma linha por pool físico',
    },
    cenarios:{
      meta_global:{
        nome:`Manter ${metaGlobal} meses de estoque`,
        descricao:`Meta única de ${metaGlobal} meses para todos os insumos (política vigente, parâmetro meta_reposicao).`,
        meta_meses:metaGlobal,vigente:true,...somaCen('cenario_meta_global'),
      },
      meta_insumo:{
        nome:'Meta por insumo',
        descricao:'Meta calibrada por insumo conforme lead time, giro, custo e fornecedor (parâmetros meta_<insumo>).',
        metas:Object.fromEntries([...new Set(linhas.map(l=>l.insumo))].map(i=>[i,metaDe(i).meses])),
        vigente:false,...somaCen('cenario_meta_insumo'),
      },
    },
    ...(await visoesFiscais(c.env.DB,linhas)),
    total:linhas.length,linhas,
  })
})

// ── Horizonte: projeção mês a mês até o fim do período ───────────────────────
// Simula a evolução do estoque de cada pool no tempo. Estoque e trânsito só
// entram UMA VEZ, no primeiro mês; a partir daí o saldo é o que sobrou do mês
// anterior. Somar a "compra sugerida" de vários meses sem essa simulação
// contaria o mesmo estoque várias vezes.
//   inicio_mes = saldo do mês anterior (1º mês = estoque atual + em trânsito)
//   alvo       = consumo do mês x meta
//   compra     = MAX(0, alvo - inicio_mes)
//   fim_mes    = inicio_mes + compra - consumo do mês
app.get('/api/sugestao-compra/horizonte',async c=>{
  await initDb(c.env.DB)
  const q=c.req.query()
  const now=new Date()
  const ano=Number(q.ano??now.getFullYear())
  const de=Number(q.de??(now.getMonth()+1))
  const ate=Number(q.ate??12)
  if(!(de>=1&&de<=12&&ate>=de&&ate<=12)) return c.json({error:'Informe de/ate entre 1 e 12, com ate >= de'},400)

  const fornRows=(await c.env.DB.query("SELECT * FROM fornecedores WHERE tipo='PRINCIPAL' ORDER BY id",[])).rows as any[]
  const principalPorInsumo:Record<string,any>={}
  for(const f of fornRows) if(!principalPorInsumo[f.insumo]) principalPorInsumo[f.insumo]=f

  const P=await loadParams(c.env.DB)
  const metaGlobal=P['meta_reposicao']??2
  const metaDe=(insumo:string)=>{const v=P[`meta_${insumo}`];return(v!=null&&isFinite(v))?v:metaGlobal}

  // Saldo inicial por pool: estoque físico + o que já está comprado.
  const saldo:Record<string,{g:number;i:number}>={}
  const meses:any[]=[];const semForecast:number[]=[]
  const acumulado:Record<string,any>={}

  for(let m=de;m<=ate;m++){
    const fcRows=(await c.env.DB.query('SELECT COUNT(*) as n FROM forecast_mensal WHERE ano=? AND mes=?',[ano,m])).rows as any[]
    if(!Number(fcRows[0]?.n)){semForecast.push(m);meses.push({mes:m,sem_forecast:true,pools:[],
      custo_meta_global:null,custo_meta_insumo:null,consumo_valorizado:null});continue}
    const fc=await poolsDoForecast(c.env.DB,ano,m)
    const linhasMes:any[]=[]
    let cg=0,ci=0,cv=0;let semPreco=0
    for(const p of fc.pools){
      const pr=precificar(p.insumo,p.unidade,0,principalPorInsumo[p.insumo],P)
      const preco=(pr.preco_status==='OK'||pr.preco_status==='OK_CONVERTIDO')?pr.preco_unitario:null
      if(preco==null) semPreco++
      if(!saldo[p.pool]){
        const base=(p.estoque_atual??0)+(p.estoque_transito||0)
        saldo[p.pool]={g:base,i:base}
      }
      const consumo=p.consumo_mensal
      const sim=(meta:number,chave:'g'|'i')=>{
        const inicio=saldo[p.pool][chave]
        const alvo=Math.round(consumo*meta)
        const compra=Math.max(0,Math.round(alvo-inicio))
        const fim=Math.round(inicio+compra-consumo)
        saldo[p.pool][chave]=Math.max(0,fim)
        return{inicio:Math.round(inicio),alvo,compra,fim:Math.max(0,fim),
          custo:preco!=null?Math.round(compra*preco*100)/100:null}
      }
      const g=sim(metaGlobal,'g')
      const i=sim(metaDe(p.insumo),'i')
      cg+=g.custo||0;ci+=i.custo||0
      cv+=preco!=null?consumo*preco:0
      linhasMes.push({pool:p.pool,label:p.label,insumo:p.insumo,cd:p.cd,marcas:p.marcas,
        unidade:p.unidade,consumo_mensal:consumo,preco_unitario:preco,
        meta_global:{...g,meta_meses:metaGlobal},
        meta_insumo:{...i,meta_meses:metaDe(p.insumo)}})
      const a=acumulado[p.pool]||(acumulado[p.pool]={pool:p.pool,label:p.label,insumo:p.insumo,
        cd:p.cd,marcas:p.marcas,unidade:p.unidade,consumo_total:0,
        compra_meta_global:0,custo_meta_global:0,compra_meta_insumo:0,custo_meta_insumo:0,
        preco_unitario:preco,meses:0})
      a.consumo_total=Math.round((a.consumo_total+consumo)*100)/100
      a.compra_meta_global+=g.compra;a.custo_meta_global+=g.custo||0
      a.compra_meta_insumo+=i.compra;a.custo_meta_insumo+=i.custo||0
      a.meses++
    }
    meses.push({mes:m,sem_forecast:false,
      custo_meta_global:Math.round(cg*100)/100,
      custo_meta_insumo:Math.round(ci*100)/100,
      consumo_valorizado:Math.round(cv*100)/100,
      itens_sem_preco:semPreco,pools:linhasMes})
  }

  const linhas=Object.values(acumulado).map((a:any)=>({...a,
    custo_meta_global:Math.round(a.custo_meta_global*100)/100,
    custo_meta_insumo:Math.round(a.custo_meta_insumo*100)/100}))
  const soma=(k:string)=>Math.round(meses.reduce((s,m)=>s+(m[k]||0),0)*100)/100
  return c.json({
    ano,de,ate,
    meses_sem_forecast:semForecast,
    aviso:semForecast.length?`Sem Forecast cadastrado para o(s) mês(es): ${semForecast.join(', ')}. Esses meses ficam fora da projeção — nenhum consumo foi estimado por interpolação.`:null,
    metodo:'Simulação mês a mês do saldo de cada pool. Estoque atual e em trânsito entram apenas no primeiro mês; nos seguintes o saldo inicial é o que sobrou do mês anterior.',
    totais:{
      custo_meta_global:soma('custo_meta_global'),
      custo_meta_insumo:soma('custo_meta_insumo'),
      consumo_valorizado:soma('consumo_valorizado'),
      meses_projetados:meses.filter(m=>!m.sem_forecast).length,
    },
    meses,linhas,
  })
})

export default app
