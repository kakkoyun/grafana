import {
  DataFrame,
  AnnotationQuery,
  AnnotationSupport,
  PanelData,
  transformDataFrame,
  FieldType,
  Field,
  KeyValue,
  AnnotationEvent,
  AnnotationEventMappings,
  getFieldDisplayName,
  AnnotationEventFieldMapValue,
} from '@grafana/data';

import isString from 'lodash/isString';

export const standardAnnotationSupport: AnnotationSupport = {
  /**
   * Assume the stored value is standard model.
   */
  prepareAnnotation: (json: any) => {
    if (isString(json?.query)) {
      const { query, ...rest } = json;
      return {
        ...rest,
        query: {
          query,
        },
        mappings: {},
      };
    }
    return json as AnnotationQuery;
  },

  /**
   * Convert the stored JSON model and environment to a standard datasource query object.
   * This query will be executed in the datasource and the results converted into events.
   * Returning an undefined result will quietly skip query execution
   */
  prepareQuery: (anno: AnnotationQuery) => anno.query,

  /**
   * When the standard frame > event processing is insufficient, this allows explicit control of the mappings
   */
  processEvents: (anno: AnnotationQuery, data: DataFrame) => {
    return getAnnotationsFromFrame(data, anno.mappings);
  },
};

/**
 * Flatten all panel data into a single frame
 */
export function singleFrameFromPanelData(rsp: PanelData): DataFrame | undefined {
  if (rsp?.series?.length) {
    return undefined;
  }
  if (rsp.series.length === 1) {
    return rsp.series[0];
  }

  return transformDataFrame(
    [
      {
        id: 'seriesToColumns',
        options: { byField: 'Time' },
      },
    ],
    rsp.series
  )[0];
}

interface AnnotationEventFieldSetter {
  key: keyof AnnotationEvent;
  field?: Field;
  text?: string;
  regex?: RegExp;
  split?: string; // for tags
}

interface AnnotationFieldDefaults {
  key: keyof AnnotationEvent;

  split?: string;
  field?: (frame: DataFrame) => Field | undefined;
  placeholder?: string;
}

const annotationEventNames: AnnotationFieldDefaults[] = [
  {
    key: 'time',
    field: (frame: DataFrame) => frame.fields.find(f => f.type === FieldType.time),
    placeholder: 'first time field',
  },
  { key: 'timeEnd' },
  {
    key: 'title',
  },
  {
    key: 'text',
    field: (frame: DataFrame) => frame.fields.find(f => f.type === FieldType.string),
    placeholder: 'first text field',
  },
  { key: 'tags', split: ',' },
  { key: 'userId' },
  { key: 'login' },
  { key: 'email' },
];

export function getAnnotationsFromFrame(frame: DataFrame, options?: AnnotationEventMappings): AnnotationEvent[] {
  if (!frame?.length) {
    return [];
  }

  let hasTime = false;
  let hasText = false;
  const byName: KeyValue<Field> = {};
  for (const f of frame.fields) {
    const name = getFieldDisplayName(f, frame);
    byName[name.toLowerCase()] = f;
  }

  if (!options) {
    options = {};
  }

  const fields: AnnotationEventFieldSetter[] = [];
  for (const evts of annotationEventNames) {
    const opt = options[evts.key] || {}; //AnnotationEventFieldMapping
    if (opt.source === AnnotationEventFieldMapValue.Skip) {
      continue;
    }
    const setter: AnnotationEventFieldSetter = { key: evts.key, split: evts.split };

    if (opt.source === AnnotationEventFieldMapValue.Text) {
      setter.text = opt.value;
    } else if (opt.value) {
      setter.field = byName[opt.value];
    } else if (evts.field) {
      setter.field = evts.field(frame);
    }

    if (setter.field || setter.text) {
      fields.push(setter);
      if (setter.key === 'time') {
        hasTime = true;
      } else if (setter.key === 'text') {
        hasText = true;
      }
    }
  }

  if (!hasTime || !hasText) {
    return []; // throw an error?
  }

  // Add each value to the string
  const events: AnnotationEvent[] = [];
  for (let i = 0; i < frame.length; i++) {
    const anno: AnnotationEvent = {};
    for (const f of fields) {
      let v: any = undefined;
      if (f.text) {
        v = f.text; // TODO support templates!
      } else if (f.field) {
        let v = f.field.values.get(i);
        if (v && f.regex) {
          const match = f.regex.exec(v);
          if (match) {
            v = match[1] ? match[1] : match[0];
          }
        }
      }

      if (v !== undefined) {
        if (f.split) {
          v = (v as string).split(',');
        }
        (anno as any)[f.key] = v;
      }
    }
    events.push(anno);
  }
  return events;
}
