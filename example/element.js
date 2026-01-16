import '../src/x-1851424-doli-comp';

const el = document.createElement('DIV');
document.body.appendChild(el);
/*
el.innerHTML = `		
	<x-1851424-doli-comp
		mode="standard"
		wafer="25"
		operation="update"
		selected='"2,7,22"'
		>
	</x-1851424-doli-comp>
`;
*/

el.innerHTML = `		
	<x-1851424-doli-comp
		mode="combine"
		wafer="25"
		operation="create"
		>
	</x-1851424-doli-comp>
`;

/*
el.innerHTML = `		
	<x-1851424-doli-comp
		mode="combine"
		wafer="25"
		operation="create"
		>
	
	</x-1851424-doli-comp>
`;
*/