function getRandomInt(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min) + min);
}

function capitalize(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Checks if a value is of a specific type.
 *
 * @param {*} value - The value to check.
 * @param {string} type - The type to check against.
 * @returns {boolean} - Returns true if the value is of the specified type, otherwise false.
 */
function isOfType(value, type) {
    let isValidValue = true;
    if (type === 'number') {
        isValidValue = Number.isFinite(value);
    }
    return Object.prototype.toString.call(value) === `[object ${capitalize(type)}]` && isValidValue;
}

function createTypeChecker(type) {
    return (value) => isOfType(value, type);
}

const isObject = createTypeChecker('object');
const isArray = createTypeChecker('array');
const isNumber = createTypeChecker('number');
const isString = createTypeChecker('string');
const isBoolean = createTypeChecker('boolean');

/**
 * A utility function for logging messages with customizable styles.
 *
 * @param {...any} args - The messages to be logged.
 */
const log = (() => {
    let pendingStyles = [];
    let pendingGroupName;

    const styleBuilders = {
        red: () => 'color: red',
        blue: () => 'color: blue',
        darkBlue: () => 'color: darkblue',
        orangeRed: () => 'color: orangered',
        yellow: () => 'color: yellow',
        black: () => 'color: black',
        purple: () => 'color: purple',
        rebeccaPurple: () => 'color: rebeccapurple',
        white: () => 'color: white',
        green: () => 'color: green',
        lightBlue: () => 'color: lightblue',
        orange: () => 'color: orange',
        lime: () => 'color: lime',
        limeGreen: () => 'color: limegreen',
        bgBlue: () => 'background-color: blue',
        bgRoyalBlue: () => 'background-color: royalblue',
        bgRed: () => 'background-color: red',
        bgYellow: () => 'background-color: yellow',
        bgPink: () => 'background-color: hotpink',
        bgBlack: () => 'background-color: black',
        bgWhite: () => 'background-color: white',
        underline: () => 'text-decoration: underline',
        bold: () => 'font-weight: 900',
        dim: () => 'color: #ffffff8d;font-style:italic',

        // Styles that accept a CSS value.
        style: (property, value) => `${property}: ${value}`,
        fontSize: (size) => `font-size: ${size}`,
        fontFamily: (family) => `font-family: ${family}`,
        color: (color) => `color: ${color}`,
        bgColor: (color) => `background-color: ${color}`,
        borderRadius: (size) => `border-radius: ${size}`,
        ...createDirectionalStyleBuilders('padding'),
        ...createDirectionalStyleBuilders('margin'),
        ...createDirectionalStyleBuilders('border'),
    };

    function createDirectionalStyleBuilders(style) {
        return {
            [style]: (value) => `${style}: ${value}`,
            [`${style}Inline`]: (value) => `${style}-inline: ${value}`,
            [`${style}Block`]: (value) => `${style}-block: ${value}`,
            [`${style}Top`]: (value) => `${style}-top: ${value}`,
            [`${style}Bottom`]: (value) => `${style}-bottom: ${value}`,
            [`${style}Left`]: (value) => `${style}-left: ${value}`,
            [`${style}Right`]: (value) => `${style}-right: ${value}`,
        };
    }

    const loggingMethods = {
        group(groupName = 'group') {
            pendingGroupName = groupName;
            return writeLog;
        },

        log(...args) {
            writeLog(...args);
        }
    };

    // Write the message, then reset the pending styles and group.
    function writeLog(...args) {
        if (pendingGroupName) writeGroupedLog(...args);
        else writeStyledLog(...args);
        pendingGroupName = '';
        pendingStyles = [];
    }

    function writeGroupedLog(...args) {
        console.group(pendingGroupName);
        writeStyledLog(...args);
        console.groupEnd();
    }

    function writeStyledLog(...args) {
        console.log('%c' + args.join(' '), pendingStyles.join(';'));
    }

    function appendStyle(style) {
        pendingStyles.push(style);
        return writeLog;
    }

    // Expose chainable style getters and logging methods.
    for (const styleName in styleBuilders) {
        const getStyle = styleBuilders[styleName];
        Object.defineProperty(writeLog, styleName, {
            get() {
                return getStyle.length
                    ? (...args) => appendStyle(getStyle(...args))
                    : appendStyle(getStyle());
            }
        });
    }

    for (const methodName in loggingMethods) {
        const method = loggingMethods[methodName];
        writeLog[methodName] = method;
    }

    return writeLog;
})();

/**
 * Converts a camelCase string to kebab-case.
 *
 * @param {string} text - The camelCase string to convert.
 * @returns {string} - The converted kebab-case string.
 */
function convertCamelToKebab(text) {
    return text.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Runs a unit test for a given function and logs the results.
 *
 * @template TInputs - The tuple type of input arguments.
 * @template TExpected - The type of the expected result.
 * @param {Object} options - The test configuration options.
 * @param {(...args: TInputs) => TExpected} options.func - The function to test.
 * @param {TInputs} options.inputs - The array of inputs to pass to the function.
 * @param {TExpected} options.expected - The expected result of the function.
 * @param {(result: TExpected, expected: TExpected) => boolean} [options.equalityFn] - Optional custom equality function to compare result with expected. Defaults to JSON.stringify comparison.
 * @returns {void}
 */
function unitTesting(options) {
    const {
        func,
        inputs,
        expected,
        equalityFn = (result, expectedResult) => JSON.stringify(result) === JSON.stringify(expectedResult),
    } = options;
    console.time('Time');
    const actualResult = func(...inputs);
    const hasPassed = equalityFn(actualResult, expected);
    console.group(func.name);
    console.log(`%c${hasPassed ? '✅ PASSED ✅' : '❗️FAILED❗️'}`, `color: ${hasPassed ? 'lime' : 'orangered'}`);
    console.log(
        'INPUT:', ...inputs,
        '\nEXPECTED:', expected,
        '\nACTUAL:', actualResult
    );
    console.timeEnd('Time');
    console.groupEnd(func.name);
    console.log('');
}
