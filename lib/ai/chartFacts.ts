/**
 * 命盘 → AI 提示词事实摘要（server only）。
 *
 * 把 ZiweiChart 序列化成一段紧凑的中文事实文本，供 /api/interpret 与
 * /api/heming 组装 system prompt。只陈述排盘引擎算出的事实，不做解读，
 * 解读交给大模型；prompt 里另有规则约束模型不编造。
 */

import { STEMS, BRANCHES, SHICHEN } from '@/lib/ziwei/constants';
import { detectPatterns, getMingGongSummary } from '@/lib/ziwei/patterns';
import { getSiHuaByStem } from '@/lib/ziwei/sihua';
import { STAR_IN_FUQI_GU } from '@/lib/ziwei/heming-knowledge';
import type { ZiweiChart, Palace, Star } from '@/lib/ziwei/types';

function starText(s: Star): string {
  let t = s.name;
  if (s.brightnessRaw) t += s.brightnessRaw;
  if (s.siHua) t += `(化${s.siHua})`;
  return t;
}

function palaceLine(p: Palace): string {
  const ganzhi = `${STEMS[p.stem]}${BRANCHES[p.branch]}`;
  const majors = p.stars.filter((s) => s.type === 'major').map(starText);
  const others = p.stars.filter((s) => s.type !== 'major').map(starText);
  let line = `${p.name}(${ganzhi})`;
  if (p.isMingGong) line += '【命宫】';
  if (p.isShenGong) line += '【身宫】';
  line += '：';
  if (majors.length) {
    line += majors.join('、');
  } else if (p.isEmpty) {
    line += `空宫（借对宫${p.borrowedFromName}：${(p.borrowedStars ?? []).join('、')}）`;
  } else {
    line += '无主星';
  }
  if (others.length) line += `；辅星杂曜：${others.join('、')}`;
  if (p.selfSihua?.length) {
    line += `；宫干自化：${p.selfSihua.map((m) => `${m.starName}化${m.siHua}`).join('、')}`;
  }
  if (p.isCurrentDaXian && p.daXianAge) {
    line += `；★当前大限(${p.daXianAge[0]}-${p.daXianAge[1]}岁)`;
  }
  return line;
}

const LEVEL_TEXT: Record<string, string> = {
  excellent: '大吉格局',
  good: '吉格局',
  neutral: '中性格局',
  caution: '需注意格局',
};

/** 单张命盘的事实摘要 */
export function chartToFacts(chart: ZiweiChart, label = '命主'): string {
  const b = chart.birthInfo;
  const l = chart.lunarInfo;
  const lines: string[] = [];

  const shichen = SHICHEN[b.hour]?.name ?? `${BRANCHES[b.hour]}时`;
  lines.push(
    `${label}：公历${b.year}年${b.month}月${b.day}日 ${shichen}生，${b.gender === 'male' ? '男' : '女'}` +
      (chart.yinYangGender ? `（${chart.yinYangGender}）` : ''),
  );
  lines.push(
    `农历${l.lunarYear}年${Math.abs(l.lunarMonth)}月${l.isLeapMonth ? '闰' : ''}${l.lunarDay}日` +
      (l.fourPillars ? `，四柱 ${l.fourPillars.join(' ')}` : ''),
  );
  lines.push(
    `五行局${chart.wuxingJuName}，命宫在${BRANCHES[chart.mingGongBranch]}，身宫在${BRANCHES[chart.shenGongBranch]}` +
      (chart.mingZhu ? `，命主${chart.mingZhu}` : '') +
      (chart.shenZhu ? `，身主${chart.shenZhu}` : ''),
  );

  // 生年四化
  const sihua = getSiHuaByStem(l.yearStem);
  lines.push(
    `生年四化（${STEMS[l.yearStem]}干）：化禄→${sihua['禄']}、化权→${sihua['权']}、化科→${sihua['科']}、化忌→${sihua['忌']}`,
  );

  // 命宫提要
  const ming = getMingGongSummary(chart);
  if (ming.stars.length || ming.nature) {
    lines.push(
      `命宫主星：${ming.stars.join('、')}${ming.nature ? `，命格气质：${ming.nature}` : ''}` +
        (ming.keywords.length ? `，关键词：${ming.keywords.join('、')}` : ''),
    );
  }

  // 格局
  const patterns = detectPatterns(chart);
  if (patterns.length) {
    lines.push(
      '格局识别：' +
        patterns
          .map(
            (p) =>
              `${p.name}（${LEVEL_TEXT[p.level] ?? p.level}）${p.source ? `[${p.source}]` : ''}：${p.description}` +
              (p.conditions?.breaking?.length ? `；破格警示：${p.conditions.breaking.join('；')}` : ''),
          )
          .join('\n'),
    );
  }

  // 十二宫
  lines.push('十二宫星曜分布：');
  for (const p of chart.palaces) {
    lines.push('  ' + palaceLine(p));
  }

  // 当前大限
  const dx = chart.daXians?.[chart.currentDaXianIndex];
  if (dx) {
    lines.push(`当前${chart.currentAge}岁，行「${dx.palaceName}」大限（${dx.startAge}-${dx.endAge}岁）`);
  }

  return lines.join('\n');
}

/** 夫妻宫主星断语（合盘用） */
function fuqiNotes(chart: ZiweiChart): string {
  const fuqi = chart.palaces.find((p) => p.name === '夫妻');
  if (!fuqi) return '';
  const majors = fuqi.stars.filter((s) => s.type === 'major').map((s) => s.name);
  if (!majors.length) return '夫妻宫空宫，借对宫星曜论断。';
  return majors
    .map((name) => {
      const k = STAR_IN_FUQI_GU[name];
      if (!k) return `${name}在夫妻宫。`;
      return `${name}在夫妻宫：${k.summary}。吉象：${k.good}。注意：${k.bad}。配偶特质：${k.spouse_traits}。婚期建议：${k.timing}${
        k.ni_quote ? `（倪师原话：${k.ni_quote}）` : ''
      }`;
    })
    .join('\n');
}

/** 合盘双方事实摘要 */
export function pairFacts(chartA: ZiweiChart, chartB: ZiweiChart): string {
  return (
    `【甲方命盘事实】\n${chartToFacts(chartA, '甲方')}\n甲方夫妻宫断语：\n${fuqiNotes(chartA)}\n\n` +
    `【乙方命盘事实】\n${chartToFacts(chartB, '乙方')}\n乙方夫妻宫断语：\n${fuqiNotes(chartB)}`
  );
}

const COMMON_RULES = `你是一位遵循倪海厦《天纪》体系的紫微斗数解盘师，用现代白话为用户解读命盘。

铁律：
1. 只依据【命盘事实】断语。事实里没有的星曜、宫位信息，绝不编造；不确定的地方如实说"盘中无此信息"。
2. 术语第一次出现时用括号给白话解释，例如"化忌（阻碍、欠债般的牵制）"。
3. 分节标题必须严格使用【标题文字】并用双星号包裹，形如 **【命格总览】**，标题独占一行、前后各空一行；禁止用 **** 空标题或 # 号标题。每节 3-6 句，讲人话、给结论，不堆术语。
4. 不做生死断语，不做疾病确诊，不预言具体年份的灾祸；健康话题只谈体质倾向并建议就医。
5. 这是传统命理文化解读，仅供娱乐参考，不构成人生决策依据。
6. 全程中文，语气像一位懂命理的朋友，不端着、不恐吓、不贩卖焦虑。`;

export function buildInterpretSystemPrompt(facts: string): string {
  return `${COMMON_RULES}

【命盘事实】
${facts}

解读框架（按用户问题聚焦，可增删小节，但须覆盖）：
**【命格总览】** 命宫主星+格局，一句话定调此人一生底色。
**【性格特质】** 主星气质+四化影响，具体、不贴标签。
**【事业财运】** 官禄、财帛、迁移三方会照，结合大限看当下十年发力方向。
**【感情婚姻】** 夫妻宫主星+桃花杂曜，给相处建议不给宿命论。
**【健康提醒】** 疾厄宫体质倾向，只谈调养方向。
**【当下运势】** 结合当前大限与年龄，给 1-2 年内的行动建议。
**【给你的三条建议】** 具体可执行。
末尾加一句：以上为传统命理文化解读，仅供娱乐参考。`;
}

export function buildHemingSystemPrompt(facts: string): string {
  return `${COMMON_RULES}

${facts}

请按以下框架做合盘解读：
**【两人命格速览】** 各一句话：甲方底色、乙方底色。
**【感情契合度】** 从双方夫妻宫主星、命宫三方互动看契合点，给综合评价（高/中/低）并说明理由。
**【潜在摩擦点】** 双方命盘中容易冲突的点（如一方化忌落对方要害宫位、一方煞重一方求稳），讲清楚、不渲染。
**【相处建议】** 3 条具体可操作的相处之道。
**【婚期/发展节奏建议】** 结合双方大限与夫妻宫断语给节奏建议，不做"必分必合"式断言。
末尾加一句：以上为传统命理文化解读，仅供娱乐参考。`;
}
