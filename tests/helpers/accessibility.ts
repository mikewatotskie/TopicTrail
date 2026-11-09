import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** The installed Android implementation is the oracle, not RN's permissive `| string` type. */
export function androidRoleSets() {
  const text = readFileSync('node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.kt', 'utf8');
  function values(name: string) {
    const body = text.split(`enum class ${name} {`)[1]?.split('public companion object')[0];
    assert.ok(body, `Installed Android ${name} enum must remain inspectable`);
    const roles = [...body.matchAll(/^\s*([A-Z]+)[,;]/gm)].map(match => match[1].toLowerCase());
    assert.ok(roles.length > 30, 'An incomplete role parser cannot silently pass the audit');
    return roles;
  }
  return { accessibilityRole: values('AccessibilityRole'), role: values('Role') };
}

export interface NativePropRecord {
  host: string;
  testID?: string;
  accessibilityRole?: string;
  role?: string;
  accessibilityLiveRegion?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessible?: boolean;
  text?: string;
  accessibilityState?: { disabled?: boolean; busy?: boolean; selected?: boolean };
  importantForAccessibility?: string;
  'aria-hidden'?: boolean;
  'aria-live'?: string;
}

/** Host simulation: captures props BEFORE RN Web mapping. Never claims to execute Android. */
export function nativeProbeSource() {
  return `import React from 'react';import * as Web from 'react-native-web';export * from 'react-native-web';
    const roles=${JSON.stringify(androidRoleSets())};
    let os='web';export const nativeProps=[];export const roleViolations=[];
    export function setProbePlatform(next){os=next;nativeProps.length=0;roleViolations.length=0;}
    export const Platform={get OS(){return os},select(options){return options[os]??options.default}};
    function text(children){return React.Children.toArray(children).map(child=>typeof child==='string'||typeof child==='number'?String(child):React.isValidElement(child)?text(child.props.children):'').join('');}
    function host(name){return React.forwardRef((props,ref)=>{
      if(os==='android'){
        const record={host:name,text:text(props.children)};
        for(const key of ['testID','accessibilityRole','role','accessibilityLiveRegion','accessibilityLabel','accessibilityHint','accessible','accessibilityState','importantForAccessibility','aria-hidden','aria-live'])record[key]=props[key];
        nativeProps.push(record);
        for(const key of ['accessibilityRole','role']){const value=props[key];if(value!=null&&(typeof value!=='string'||!roles[key].includes(value.toLowerCase())))roleViolations.push(name+'.'+key+'='+String(value));}
      }
      return React.createElement(Web[name],{...props,ref});
    });}
    export const Text=host('Text'),View=host('View'),TextInput=host('TextInput'),TouchableOpacity=host('TouchableOpacity'),ActivityIndicator=host('ActivityIndicator');`;
}
