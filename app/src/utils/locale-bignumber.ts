import BigNumber from 'bignumber.js';
import { getLocales } from 'expo-localization';

let usesComma: boolean | undefined;

function localeUsesComma(): boolean {
  usesComma ??= getLocales()[0].decimalSeparator === ',';
  return usesComma;
}

export function localeParseBigNumber(numStr: string): BigNumber {
  if (localeUsesComma()) {
    return new BigNumber(numStr.replace('.', '').replace(',', '.'));
  }
  return new BigNumber(numStr);
}

export function localeFormatBigNumber(num: BigNumber | undefined, decimalPlaces?: number): string {
  if (!num) {
    return '';
  }
  const format = {
    groupSeparator: localeUsesComma() ? ' ' : ',',
    groupSize: 3,
    decimalSeparator: localeUsesComma() ? ',' : '.',
  };
  if (localeUsesComma()) {
    return decimalPlaces !== undefined ? num.toFormat(decimalPlaces, format) : num.toFormat(format);
  }
  return decimalPlaces !== undefined ? num.toFormat(decimalPlaces, format) : num.toFormat(format);
}
