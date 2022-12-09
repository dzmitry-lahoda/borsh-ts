import {
  FixedArrayKind,
  OptionKind,
  Field,
  StructKind,
  VecKind,
  SimpleField,
  CustomField,
  extendingClasses,
  Constructor,
  AbstractType,
  PrimitiveType,
} from "./types.js";
export * from "./binary.js";
export * from "./types.js";
export * from './error.js';
import { BorshError } from "./error.js";
import { BinaryWriter, BinaryReader } from "./binary.js";

export function serializeField(
  fieldName: string,
  value: any,
  fieldType: any, // A simple type of a CustomField
  writer: BinaryWriter
) {
  try {
    // TODO: Handle missing values properly (make sure they never result in just skipped write)

    if (typeof fieldType["serialize"] == "function") {
      fieldType.serialize(value, writer);
    }
    else if (value === null || value === undefined) {
      if (fieldType instanceof OptionKind) {
        writer.u8(0);
      } else {
        throw new BorshError(`Trying to serialize a null value to field "${fieldName}" which is not allowed since the field is not decorated with "option(...)" but "${typeof fieldType === 'function' && fieldType?.name ? fieldType?.name : fieldType}". Most likely you have forgotten to assign this value before serializing`)
      }
    }
    else if (typeof fieldType === "string") {
      switch (fieldType as PrimitiveType) {
        case "bool":
          writer.bool(value);
          break;
        case "string":
          writer.string(value);
          break;
        case "u8":
          writer.u8(value)
          break;
        case "u16":
          writer.u16(value)
          break;
        case "u32":
          writer.u32(value)
          break;
        case "u64":
          writer.u64(value)
          break;
        case "u128":
          writer.u128(value)
          break;
        case "u256":
          writer.u256(value)
          break;
        case "u512":
          writer.u512(value)
          break;
        default:
          throw new Error("Unsuppported")
      }
    }
    else if (fieldType instanceof OptionKind) {
      writer.u8(1);
      serializeField(fieldName, value, fieldType.elementType, writer);
    }
    else if (fieldType === Uint8Array) {
      const arr = value as Uint8Array;
      writer.uint8Array(arr)
    }
    else if (
      fieldType instanceof VecKind ||
      fieldType instanceof FixedArrayKind
    ) {
      let len = value.length;
      if (fieldType instanceof FixedArrayKind) {
        if (fieldType.length != len) {
          throw new BorshError(
            `Expecting array of length ${(fieldType as any)[0]}, but got ${value.length
            }`
          );
        }
      } else {
        writer.u32(len); // For dynamically sized array we write the size as u32 according to specification
      }
      for (let i = 0; i < len; i++) {
        serializeField(null, value[i], fieldType.elementType, writer);
      }
    } else {
      if (!checkClazzesCompatible(value.constructor, fieldType)) {
        throw new BorshError(`Field value of field ${fieldName} is not instance of expected Class ${getSuperMostClass(fieldType)?.name}. Got: ${value.constructor.name}`)
      }
      serializeStruct(value, writer);
    }
  } catch (error) {
    if (error instanceof BorshError) {
      error.addToFieldPath(fieldName);
    }
    throw error;
  }
}

export function serializeStruct(
  obj: any,
  writer: BinaryWriter
) {

  if (typeof obj.borshSerialize === "function") {
    obj.borshSerialize(writer);
    return;
  }



  // Serialize content as struct, we do not invoke serializeStruct since it will cause circular calls to this method
  const structSchemas = getSchemasBottomUp(obj.constructor);

  // If Schema has fields, "structSchema" will be non empty and "fields" will exist
  if (structSchemas.length == 0) {
    throw new BorshError(`Class ${obj.constructor.name} is missing in schema`);
  }

  structSchemas.forEach((v) => {
    if (v.schema instanceof StructKind) {
      const index = v.schema.variant;
      if (index != undefined) {
        if (typeof index === "number") {
          writer.u8(index);
        } else if (Array.isArray(index)) {
          index.forEach((i) => {
            writer.u8(i);
          });
        }
        else { // is string
          writer.string(index);
        }
      }

      v.schema.fields.map((field) => {
        serializeField(field.key, obj[field.key], field.type, writer);
      });
    } else {
      throw new BorshError(`Unexpected schema for ${obj.constructor.name}`);
    }
  })

}

/// Serialize given object using schema of the form:
/// { class_name -> [ [field_name, field_type], .. ], .. }
export function serialize(
  obj: any
): Uint8Array {
  const writer = new BinaryWriter();
  serializeStruct(obj, writer);
  return writer.toArray();
}

function deserializeField(
  fieldName: string,
  fieldType: any,
  reader: BinaryReader,
  options: DeserializeStructOptions
): any {
  try {
    if (typeof fieldType === "string") {
      switch (fieldType as PrimitiveType) {
        case "bool":
          return reader.bool();
        case "string":
          return reader.string();
        case "u8":
          return reader.u8()
        case "u16":
          return reader.u16()
        case "u32":
          return reader.u32()
        case "u64":
          return reader.u64()
        case "u128":
          return reader.u128()
        case "u256":
          return reader.u256()
        case "u512":
          return reader.u512()
        default:
          throw new Error("Unsuppported type: " + fieldType)
      }
    }

    if (fieldType === Uint8Array) {
      return reader.uint8Array()
    }

    if (fieldType instanceof VecKind || fieldType instanceof FixedArrayKind) {
      let len =
        fieldType instanceof FixedArrayKind
          ? fieldType.length
          : reader.u32();
      let arr = new Array(len);
      for (let i = 0; i < len; i++) {
        arr[i] = deserializeField(null, fieldType.elementType, reader, options);
      }
      return arr;
    }
    if (typeof fieldType["deserialize"] == "function") {
      return fieldType.deserialize(reader);
    }

    if (fieldType instanceof OptionKind) {
      const option = reader.u8();
      if (option) {
        return deserializeField(
          fieldName,
          fieldType.elementType,
          reader,
          options
        );
      }
      return undefined;
    }

    return deserializeStruct(fieldType, reader, options);
  } catch (error) {
    if (error instanceof BorshError) {
      error.addToFieldPath(fieldName);
    }
    throw error;
  }
}

function deserializeStruct(targetClazz: any, reader: BinaryReader, options: DeserializeStructOptions) {
  if (typeof targetClazz.borshDeserialize === "function") {
    return targetClazz.borshDeserialize(reader);
  }

  const result: { [key: string]: any } = {};

  const clazz = getSuperMostClass(targetClazz);

  // assume clazz is super class
  if (getVariantIndex(clazz) !== undefined) {
    // It is an (stupid) enum, but we deserialize into its variant directly
    // This means we should omit the variant index
    let index = getVariantIndex(clazz);
    if (typeof index === "number") {
      reader.u8();
    } else if (Array.isArray(index)) {
      for (const _ of index) {
        reader.u8();
      }
    }
    else { // string
      reader.string();
    }
  }


  // Polymorphic serialization, i.e. reversed prototype iteration using discriminators
  let once = false;
  let currClazz = clazz;
  while ((getSchema(currClazz) || getDependencies(currClazz).size > 0)) {

    let structSchema = getSchema(currClazz);

    once = true;
    let variantsIndex: number[] = undefined;
    let variantString: string = undefined;

    let nextClazz = undefined;
    let dependencies = getNonTrivialDependencies(currClazz);
    if (structSchema) {
      for (const field of structSchema.fields) {
        result[field.key] = deserializeField(
          field.key,
          field.type,
          reader,
          options
        );
      }
    }
    // We know that we should serialize into the variant that accounts to the first byte of the read
    for (const [_key, actualClazz] of dependencies) {
      const variantIndex = getVariantIndex(actualClazz);
      if (variantIndex !== undefined) {
        if (typeof variantIndex === "number") {

          if (!variantsIndex) {
            variantsIndex = [reader.u8()];
          }
          if (variantIndex == variantsIndex[0]) {
            nextClazz = actualClazz;
            break;
          }
        }
        else if (Array.isArray(variantIndex)) { // variant is array, check all values

          if (!variantsIndex) {
            variantsIndex = [];
            while (variantsIndex.length < variantIndex.length) {
              variantsIndex.push(reader.u8());
            }
          }

          // Compare variants
          if (
            variantsIndex.length === variantIndex.length &&
            (variantsIndex as number[]).every((value, index) => value === variantIndex[index])
          ) {
            nextClazz = actualClazz;
            break;
          }
        }

        else { // is string
          if (variantString == undefined) {
            variantString = reader.string();
          }
          // Compare variants is just string compare
          if (
            variantString === variantIndex
          ) {
            nextClazz = actualClazz;
            break;
          }
        }
      }
    }
    if (nextClazz == undefined) {
      // do a recursive call and copy result, 
      // this is not computationally performant since we are going to traverse multiple path
      // and possible do deserialziation on bad paths
      if (dependencies.size == 1) // still deterministic
        nextClazz = dependencies.values().next().value;
      else if (dependencies.size > 1) {
        const classes = [...dependencies.values()].map((f) => f.name).join(', ')
        throw new BorshError(`Multiple deserialization paths from ${currClazz.name} found: ${classes} but no matches the variant read from the buffer.`)
      }
    }

    if (nextClazz == undefined) {
      break;
    }
    currClazz = nextClazz;
  }
  if (!once) {
    throw new BorshError(`Unexpected schema ${clazz.constructor.name}`);
  }
  if (!checkClazzesCompatible(currClazz, targetClazz)) {
    throw new BorshError(`Deserialization of ${targetClazz?.name || targetClazz} yielded another Class: ${clazz?.name || clazz} which are not compatible`);

  }
  if ((options as any)?.object) {
    return result;
  }
  return Object.assign((options as any)?.construct ? new currClazz() : Object.create(currClazz.prototype), result);

}

const intoUint8Array = (buf: Uint8Array) => {
  if (buf.constructor !== Uint8Array) {
    if (buf instanceof Uint8Array) {
      buf = new Uint8Array(buf);
    }
    else {
      throw new BorshError("Expecing Uint8Array, instead got: " + buf["constructor"]?.["name"])
    }
  }
  return buf;
}

/**
 * /// Deserializes object from bytes using schema.
 * @param buffer data
 * @param classType target Class
 * @param options options
 * @param options.unchecked if true then any remaining bytes after deserialization will be ignored
 * @param options.construct if true, constructors will be invoked on deserialization
 * @returns
 */


type DeserializeStructOptions = { construct?: boolean } | { object?: boolean };
export function deserialize<T>(
  buffer: Uint8Array,
  classType: Constructor<T> | AbstractType<T>,
  options?: {
    unchecked?: boolean
  } & DeserializeStructOptions
): T {
  buffer = intoUint8Array(buffer);
  const reader = new BinaryReader(buffer);
  const result = deserializeStruct(classType, reader, options);
  if (!options?.unchecked && reader._offset !== buffer.length) {
    throw new BorshError(
      `Unexpected ${buffer.length - reader._offset
      } bytes after deserialized data`
    );
  }
  return result;
}

/// Deserializes object from bytes using schema, without checking the length read
/**
 * @deprecated use deserialize(..., ..., { unchecked: true }) instead
 */
export function deserializeUnchecked<T>(
  classType: { new(args: any): T },
  buffer: Uint8Array,
  options?: {
    construct?: boolean
  }
): T {
  buffer = intoUint8Array(buffer);
  const reader = new BinaryReader(buffer);
  return deserializeStruct(classType, reader, options);
}


const getOrCreateStructMeta = (clazz: any): StructKind => {
  let schema: StructKind = getSchema(clazz)
  if (!schema) {
    schema = new StructKind();
  }
  setSchema(clazz, schema);
  return schema
}
const setDependencyToProtoType = (ctor: Function) => {
  let proto = Object.getPrototypeOf(ctor);
  if (proto.prototype?.constructor != undefined)
    setDependency(proto, ctor);
}

const setDependency = (ctor: Function, dependency: Function) => {
  let dependencies = getDependencies(ctor);
  let key = JSON.stringify(getVariantIndex(dependency));
  let classPathKey = "__" + getClassID(ctor) + "/" + getClassID(dependency);
  if (dependencies.has(classPathKey) && key != undefined) {
    dependencies.delete(classPathKey)
  }
  if (key != undefined && dependencies.has(key)) {
    if (dependencies.get(key) == dependency) {
      // already added;
      return;
    }
    throw new BorshError(`Conflicting variants: Dependency ${dependencies.get(key).name} and ${dependency.name} share same variant index(es)`)
  }
  if (key == undefined) {
    /**
     * Class is not a variant but a "bridging class" i.e
     * class A {}
     * class B extends A { @field... }
     * 
     * @variant(0)
     * class C extends B {}
     * 
     * class B has no variant even though A is a dependency on it, so it gets the key "A/B" instead
     */
    key = classPathKey;
  }
  dependencies.set(key, dependency);
  setDependencies(ctor, dependencies);
}
const getSuperMostClass = (clazz: Constructor<any>) => {
  while (Object.getPrototypeOf(clazz).prototype != undefined) {
    clazz = Object.getPrototypeOf(clazz);
  }
  return clazz;
}
/**
 * @param clazzA 
 * @param clazzB 
 * @returns true if A inherit B or B inherit A or A == B, else false
 */
const checkClazzesCompatible = (clazzA: Constructor<any> | AbstractType<any>, clazzB: Constructor<any> | AbstractType<any>) => {
  return clazzA == clazzB || clazzA.isPrototypeOf(clazzB) || clazzB.isPrototypeOf(clazzA)
}

const getFullPrototypeName = (clazz: Function) => {
  let str = clazz.name;
  while (Object.getPrototypeOf(clazz).prototype != undefined) {
    clazz = Object.getPrototypeOf(clazz);
    str += '/' + clazz.name
  }
  return str;
}

const getClassID = (ctor: Function) => {
  return getFullPrototypeName(ctor)
}

const getDependencyKey = (ctor: Function) => {

  return "_borsh_dependency_" + getClassID(ctor);
}

const getDependencies = (ctor: Function): Map<string, Function> => {
  let existing = ctor.prototype.constructor[getDependencyKey(ctor)]
  if (existing)
    return existing;
  return new Map();
}

const getNonTrivialDependencies = (ctor: Function): Map<string, Function> => {
  let ret = new Map<string, Function>();
  let existing = ctor.prototype.constructor[getDependencyKey(ctor)] as Map<string, Function>;
  if (existing)
    existing.forEach((v, k) => {
      let schema = getSchema(v);
      if (schema.fields.length > 0 || schema.variant != undefined) { // non trivial
        ret.set(k, v);
      }
      else { // check recursively
        let req = getNonTrivialDependencies(v);
        req.forEach((rv, rk) => {
          ret.set(rk, rv);
        })
      }

    });
  return ret;
}

const setDependencies = (ctor: Function, dependencies: Map<string, Function>): Map<string, Function> => {
  return ctor.prototype.constructor[getDependencyKey(ctor)] = dependencies
}


/**
 * Flat map class inheritance tree into hashmap where key represents variant key
 * @param ctor 
 * @param mem 
 * @returns a map of dependencies
 */
const getDependenciesRecursively = (ctor: Function, mem: Map<string, Function> = new Map()): Map<string, Function> => {
  let dep = getDependencies(ctor);
  for (const [key, f] of dep) {
    if (mem.has(key)) {
      continue;
    }
    mem.set(key, f);
    getDependenciesRecursively(f, mem);
  }
  return mem
}



const setSchema = (ctor: Function, schema: StructKind) => {

  ctor.prototype.constructor["_borsh_schema_" + getClassID(ctor)] = schema
}

export const getSchema = (ctor: Function): StructKind => {
  return ctor.prototype.constructor["_borsh_schema_" + getClassID(ctor)];
}

export const getSchemasBottomUp = (ctor: Function): { clazz: Function, schema: StructKind }[] => {
  let schemas: { clazz: Function, schema: StructKind }[] = [];
  while (ctor?.prototype != undefined) {
    let schema = getSchema(ctor);
    if (schema)
      schemas.push({
        clazz: ctor,
        schema
      });
    ctor = Object.getPrototypeOf(ctor);
  }
  if (schemas.length > 1)
    return schemas.reverse();
  return schemas;

}

Object.defineProperty
/**
 *
 * @param kind 'struct' or 'variant. 'variant' equivalnt to Rust Enum
 * @returns Schema decorator function for classes
 */
export const variant = (index: number | number[] | string) => {
  return (ctor: Function) => {
    let schema = getOrCreateStructMeta(ctor);

    // Create a custom serialization, for enum by prepend instruction index
    schema.variant = index;

    // Define Schema for this class, even though it might miss fields since this is a variant
    const clazzes = extendingClasses(ctor);
    let prev = ctor;
    for (const clazz of clazzes) {
      setDependency(clazz, prev); // Super classes are marked so we know they have some importance/meaningfulness
      prev = clazz;
    }


  };
};

export const getVariantIndex = (clazz: any): number | number[] | string | undefined => {
  return getOrCreateStructMeta(clazz).variant;
};

/**
 * @param properties, the properties of the field mapping to schema
 * @returns
 */
export function field(properties: SimpleField | CustomField<any>) {
  return (target: {} | any, name?: PropertyKey): any => {
    setDependencyToProtoType(target.constructor);
    const schema = getOrCreateStructMeta(target.constructor);
    const key = name.toString();

    let field: Field = undefined;
    if ((properties as SimpleField)["type"] != undefined) {
      field = {
        key,
        type: (properties as SimpleField)["type"],
      };
    } else {
      field = {
        key,
        type: properties as CustomField<any>,
      };
    }

    if (properties.index === undefined) {
      schema.fields.push(field); // add to the end. This will make property decorator execution order define field order
    } else {
      if (schema.fields[properties.index]) {
        throw new BorshError(
          "Multiple fields defined at the same index: " +
          properties.index +
          ", class: " +
          target.constructor.name
        );
      }
      if (properties.index >= schema.fields.length) {
        resize(schema.fields, properties.index + 1, undefined);
      }
      schema.fields[properties.index] = field;
    }
  };
}

/**
 * @param clazzes
 * @param validate, run validation?
 * @returns Schema map
 */
export const validate = (clazzes: Constructor<any> | Constructor<any>[], allowUndefined = false) => {
  return validateIterator(clazzes, allowUndefined, new Set());
};

const validateIterator = (clazzes: Constructor<any> | Constructor<any>[], allowUndefined: boolean, visited: Set<string>) => {
  clazzes = Array.isArray(clazzes) ? clazzes : [clazzes];
  let schemas = new Map<any, StructKind>();
  clazzes.forEach((clazz, ix) => {
    clazz = getSuperMostClass(clazz);
    let dependencies = getDependenciesRecursively(clazz);
    dependencies.set('_', clazz);
    dependencies.forEach((v, k) => {
      const schema = getSchema(v);
      if (!schema) {
        return;
      }
      schemas.set(v, schema);
      visited.add(v.name);


    });

    let lastVariant: number | number[] | string = undefined;
    let lastKey: string = undefined;
    getNonTrivialDependencies(clazz).forEach((dependency, key) => {
      if (!lastVariant)
        lastVariant = getVariantIndex(dependency);
      else if (!validateVariantAreCompatible(lastVariant, getVariantIndex(dependency))) {
        throw new BorshError(`Class ${dependency.name} is extended by classes with variants of different types. Expecting only one of number, number[] or string`)
      }

      if (lastKey != undefined && lastVariant == undefined) {
        throw new BorshError(`Classes inherit ${clazz} and are introducing new field without introducing variants. This leads to unoptimized deserialization`)
      }
      lastKey = key;
    })

    schemas.forEach((structSchema, clazz) => {
      structSchema.fields.forEach((field) => {
        if (!field) {
          throw new BorshError(
            "Field is missing definition, most likely due to field indexing with missing indices"
          );
        }
        if (allowUndefined) {
          return;
        }
        if (field.type instanceof Function) {
          if (!getSchema(field.type) && getNonTrivialDependencies(field.type).size == 0) {
            throw new BorshError("Unknown field type: " + field.type.name);
          }

          // Validate field
          validateIterator(field.type, allowUndefined, visited);
        }
      });
    })
  });


}


const resize = (arr: Array<any>, newSize: number, defaultValue: any) => {
  while (newSize > arr.length) arr.push(defaultValue);
  arr.length = newSize;
};

const validateVariantAreCompatible = (a: number | number[] | string, b: number | number[] | string) => {
  if (typeof a != typeof b) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length != b.length) {
      return false;
    }
  }
  return true;
}

export const getDiscriminator = (constructor: Constructor<any>): Uint8Array => {
  const schemas = getSchemasBottomUp(constructor);
  // assume ordered
  const writer = new BinaryWriter();
  for (let i = 0; i < schemas.length; i++) {
    const clazz = schemas[i];
    if (i !== schemas.length - 1 && clazz.schema.fields.length > 0) {
      throw new BorshError("Discriminator can not be resolved for inheritance where super class contains fields, undefined behaviour")
    }
    const variant = clazz.schema.variant;
    if (variant == undefined) {
      continue;
    }
    if (typeof variant === 'string') {
      writer.string(variant)
    }
    else if (typeof variant === 'number') {
      writer.u8(variant)
    }
    else if (Array.isArray(variant)) {
      variant.forEach((v) => {
        writer.u8(v)
      })
    }
    else {
      throw new BorshError("Can not resolve discriminator for variant with type: " + (typeof variant))
    }

  }

  return writer.toArray();

}