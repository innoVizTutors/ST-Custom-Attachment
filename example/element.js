<<<<<<< HEAD
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
=======
import "../src/x-1621019-doli-custom-attachment";

const el = document.createElement("DIV");
document.body.appendChild(el);

el.innerHTML = `		
	<x-1621019-doli-custom-attachment
		record-id="85071a1347c12200e0ef563dbb9a71c1"
		table-name="incident"
		read-only="false"
		extensions="">
	</x-1621019-doli-custom-attachment>
`;
>>>>>>> 4111146 (Doli Validations)
